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
import { FusionixError } from "../errors.ts";
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
import { chooseWriter, acceptTopOnConsensus } from "./aggregator.ts";
import type { ChatGateway } from "../gateway/contract.ts";
import type { GatewayClientOptions } from "../gateway/openrouter.ts";
import type {
  FusionixChatCompletionRequest,
  FusionixConfig,
  FusionixRunResult,
  FusionixStage,
  GatewayCallResult,
} from "../types.ts";

const DEFAULT_MAX_REQUEST_DURATION_MS = 180_000;

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
  const onCallerAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), maxMs);
  if (typeof timer.unref === "function") timer.unref();

  const deps = { gateway, signal: controller.signal };

  try {
    if (plan.bypass) {
      return await runBypass(plan, deps, opts, startedAt, now);
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
    // answer and skip the writer synthesis entirely (one fewer model call).
    const accepted = plan.acceptOnConsensus ? acceptTopOnConsensus(analysis, survivorResponses) : undefined;

    let answer: string;
    let modelUsed: string;
    let writerCalls: GatewayCallResult[];
    if (accepted) {
      answer = accepted.answer ?? "";
      modelUsed = accepted.model;
      writerCalls = [];
    } else {
      // Adaptive aggregator (§22.2): optionally pick the writer from the surviving panel
      // models (judge ranking or capability prior). Defaults to plan.writer ("fixed").
      const chosenWriter = chooseWriter(plan, analysis, survivors);
      const writerPlan = chosenWriter === plan.writer ? plan : { ...plan, writer: chosenWriter };
      opts.onProgress?.("writer");
      const writerDeps = opts.onWriterDelta ? { ...deps, onDelta: opts.onWriterDelta } : deps;
      const out = await runWriter(writerPlan, prompt, analysis, writerDeps);
      answer = out.answer;
      modelUsed = writerPlan.writer;
      writerCalls = [out.call];
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
    return result;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onCallerAbort);
  }
}
