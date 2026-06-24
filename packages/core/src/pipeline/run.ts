/**
 * Pipeline orchestration (spec §6.7, §6.8, §17).
 *
 * Resolves the plan, then either runs the single-model bypass (§6.7) or the full
 * panel → judge → writer pipeline with a shared request deadline. The deadline
 * aborts outstanding gateway calls; if the panel has ≥1 survivor we proceed to
 * judge (which then fails if no time remains), distinguishing all_panel_failed
 * from judge_failed (§17).
 */
import { finalizeCost } from "../cost.ts";
import { FusionixError, isFusionixError } from "../errors.ts";
import { loadConfig } from "../config.ts";
import { renderCompactPrompt } from "../messages.ts";
import { normalizeRequest } from "../normalize.ts";
import { webStatus } from "../gateway/web.ts";
import { OpenRouterGateway } from "../gateway/openrouter.ts";
import { runPanel } from "./panel.ts";
import { runJudge } from "./judge.ts";
import { runWriter } from "./writer.ts";
import { runBypass } from "./bypass.ts";
import { runDebate } from "./debate.ts";
import { runChain } from "./chain.ts";
import { chooseWriter, acceptTopOnConsensus, writerPanelContext } from "./aggregator.ts";
import type { ChatGateway } from "../gateway/contract.ts";
import type { GatewayClientOptions } from "../gateway/openrouter.ts";
import type {
  FusionixChatCompletionRequest,
  FusionixConfig,
  FusionixRunResult,
  FusionixStage,
  GatewayCallResult,
} from "../types.ts";

// The hard request deadline must accommodate the heaviest shipped preset. A
// research-high + web run (three frontier reasoning models in the panel, then a
// reasoning judge over the web-grounded answers, then the writer) was measured at
// ~5 minutes end-to-end, with the panel stage alone past 180s — so the previous
// 180s default aborted the judge mid-flight on every such run. Callers (and the
// CLI's --max-duration) override via RunFusionixOptions.maxRequestDurationMs.
const DEFAULT_MAX_REQUEST_DURATION_MS = 600_000;

export interface RunFusionixOptions {
  /** Pre-loaded config; if omitted, loadConfig() runs (reads bundled default + overrides). */
  config?: FusionixConfig;
  /** Gateway API key (e.g. OPENROUTER_API_KEY). Required unless `gateway` is injected. */
  apiKey?: string;
  /** Gateway base URL; defaults to config.gateway. */
  baseUrl?: string;
  /** Injectable fetch (defaults to global). */
  fetch?: typeof fetch;
  /** Inject a gateway directly (tests); bypasses OpenRouterGateway construction. */
  gateway?: ChatGateway;
  /** Caller cancellation. */
  signal?: AbortSignal;
  /** Hard cap on total request duration (§7.3). Default 180000. */
  maxRequestDurationMs?: number;
  /** Force web on/off (CLI --no-web). */
  webOverride?: boolean;
  runId?: string;
  referer?: string;
  title?: string;
  categories?: string;
  onProgress?: (stage: FusionixStage) => void;
  /** Stream the final answer (writer / bypass) token-by-token (CLI --stream). */
  onWriterDelta?: (delta: string) => void;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

function buildGateway(config: FusionixConfig, opts: RunFusionixOptions): ChatGateway {
  if (opts.gateway) return opts.gateway;
  if (!opts.apiKey) {
    throw new FusionixError("gateway_error", "No gateway API key configured (set OPENROUTER_API_KEY).");
  }
  const clientOpts: GatewayClientOptions = { apiKey: opts.apiKey, baseUrl: opts.baseUrl ?? config.gateway };
  if (opts.fetch) clientOpts.fetch = opts.fetch;
  if (opts.referer) clientOpts.referer = opts.referer;
  if (opts.title) clientOpts.title = opts.title;
  if (opts.categories) clientOpts.categories = opts.categories;
  return new OpenRouterGateway(clientOpts);
}

export async function runFusionix(
  request: FusionixChatCompletionRequest,
  opts: RunFusionixOptions = {},
): Promise<FusionixRunResult> {
  const now = opts.now ?? Date.now;
  const startedAt = now();

  const config = opts.config ?? (await loadConfig());
  const normOpts: { runId?: string; webOverride?: boolean } = {};
  if (opts.runId) normOpts.runId = opts.runId;
  if (opts.webOverride !== undefined) normOpts.webOverride = opts.webOverride;
  const plan = normalizeRequest(request, config, normOpts); // throws invalid_request / not_a_fusionix_request

  const gateway = buildGateway(config, opts);

  // Shared request deadline.
  const maxMs = opts.maxRequestDurationMs ?? DEFAULT_MAX_REQUEST_DURATION_MS;
  const controller = new AbortController();
  // Distinguish a deadline overrun from a caller abort so the terminal error can
  // explain itself (§17) instead of surfacing the raw "aborted"/"non-JSON" cause.
  let deadlineHit = false;
  const onCallerAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    deadlineHit = true;
    controller.abort();
  }, maxMs);
  if (typeof timer.unref === "function") timer.unref();

  const deps = { gateway, signal: controller.signal };

  try {
    if (plan.bypass) {
      return await runBypass(plan, deps, opts, startedAt, now);
    }
    if (plan.topology === "chain") {
      // Sequential planner → builder → finalizer; no panel/judge/writer (§23.4).
      return await runChain(plan, deps, opts, startedAt, now);
    }

    opts.onProgress?.("panel");
    const { responses, calls: panelCalls, webUsed } = await runPanel(plan, deps);
    // §17: panel members that completed before the deadline keep their results
    // (their promises already settled); only in-flight ones abort. With ≥1
    // survivor we proceed to judge. maxRequestDurationMs is a HARD cap, so if the
    // deadline already fired the shared signal, the judge/writer calls abort and
    // surface as judge_failed/writer_failed — distinct from all_panel_failed here.
    const successes = responses.filter((r) => r.error === undefined && r.answer !== undefined);
    if (successes.length === 0) {
      throw new FusionixError("all_panel_failed", "All panel models failed.", { runId: plan.runId });
    }

    const prompt = renderCompactPrompt(plan.messages);

    // Debate topology (§22.5): one inter-panel revision round before the judge. The
    // revised answers replace the round-1 answers for the judge and the result.
    let panelForJudge = responses;
    let debateCalls: GatewayCallResult[] = [];
    if (plan.topology === "debate") {
      opts.onProgress?.("debate");
      const debate = await runDebate(plan, prompt, responses, deps);
      panelForJudge = debate.responses;
      debateCalls = debate.calls;
    }

    opts.onProgress?.("judge");
    const { analysis, calls: judgeCalls } = await runJudge(plan, prompt, panelForJudge, deps);

    const survivorResponses = panelForJudge.filter((r) => r.error === undefined && r.answer !== undefined);
    const survivors = survivorResponses.map((r) => r.model);

    // Verifier accept-gate (§23.1): on full judge consensus, accept the top panelist's
    // answer and skip the writer synthesis entirely (one fewer model call). An empty
    // accepted answer falls through to the writer, so the run never returns empty content
    // (the writer path surfaces writer_failed instead, matching every other terminal path).
    const candidate = plan.acceptOnConsensus ? acceptTopOnConsensus(analysis, survivorResponses) : undefined;
    const accepted = candidate && (candidate.answer ?? "").trim().length > 0 ? candidate : undefined;

    let answer: string;
    let modelUsed: string;
    let writerCalls: GatewayCallResult[];
    let modelSelected: boolean;
    let finishReason: string | undefined;
    if (accepted) {
      answer = accepted.answer ?? "";
      modelUsed = accepted.model;
      writerCalls = [];
      modelSelected = true; // the answering model is a panelist, not the configured writer
    } else {
      // Adaptive aggregator (§22.2): optionally pick the writer from the surviving panel
      // models (judge ranking or capability prior). Defaults to plan.writer ("fixed").
      const chosenWriter = chooseWriter(plan, analysis, survivors);
      const writerPlan = chosenWriter === plan.writer ? plan : { ...plan, writer: chosenWriter };
      opts.onProgress?.("writer");
      const writerDeps = opts.onWriterDelta ? { ...deps, onDelta: opts.onWriterDelta } : deps;
      // Access-list (§23.3): grant the writer extra panel context per plan.writerAccess.
      const panelCtx = writerPanelContext(plan, analysis, survivorResponses);
      const out = await runWriter(writerPlan, prompt, analysis, writerDeps, panelCtx);
      answer = out.answer;
      modelUsed = writerPlan.writer;
      writerCalls = [out.call];
      modelSelected = chosenWriter !== plan.writer;
      finishReason = out.call.finishReason;
    }

    const allCalls = [...panelCalls, ...debateCalls, ...judgeCalls, ...writerCalls];
    const { usage, costUsd } = await finalizeCost(deps.gateway, allCalls);
    const result: FusionixRunResult = {
      runId: plan.runId,
      answer,
      model: modelUsed,
      judge: plan.judge,
      panel: panelForJudge,
      analysis,
      usage,
      costUsd,
      durationMs: now() - startedAt,
      web: webStatus(plan.web, webUsed),
      maxToolCallsEnforced: false,
      created: Math.floor(startedAt / 1000),
    };
    if (accepted) result.acceptedOnConsensus = true;
    if (modelSelected) result.modelSelected = true;
    if (finishReason) result.finishReason = finishReason;
    return result;
  } catch (err) {
    // A deadline overrun surfaces from whichever stage was in flight, as that
    // stage's terminal code (§17): all_panel_failed when no panel survivor,
    // otherwise judge_failed / writer_failed once the shared signal is aborted.
    // Keep the code (the §17 contract) but replace the cryptic underlying cause
    // ("aborted" / "non-JSON response") with a message that names the deadline and
    // how to raise it.
    if (
      deadlineHit &&
      isFusionixError(err) &&
      (err.code === "all_panel_failed" || err.code === "judge_failed" || err.code === "writer_failed")
    ) {
      const stage =
        err.code === "all_panel_failed" ? "panel" : err.code === "judge_failed" ? "judge" : "writer";
      throw new FusionixError(
        err.code,
        `Request deadline of ${maxMs}ms exceeded during the ${stage} stage. ` +
          `Raise it with --max-duration <seconds> (CLI) or maxRequestDurationMs (SDK/core).`,
        { runId: plan.runId, cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onCallerAbort);
  }
}
