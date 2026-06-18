/**
 * Pipeline orchestration (spec §6.7, §6.8, §17).
 *
 * Resolves the plan, then either runs the single-model bypass (§6.7) or the full
 * panel → judge → writer pipeline with a shared request deadline. The deadline
 * aborts outstanding gateway calls; if the panel has ≥1 survivor we proceed to
 * judge (which then fails if no time remains), distinguishing all_panel_failed
 * from judge_failed (§17).
 */
import { aggregateUsage } from "../cost.ts";
import { FusionError } from "../errors.ts";
import { loadConfig } from "../config.ts";
import { renderCompactPrompt } from "../messages.ts";
import { normalizeRequest } from "../normalize.ts";
import { applyWeb } from "../gateway/web.ts";
import { OpenRouterGateway, makeChatRequest } from "../gateway/openrouter.ts";
import { runPanel } from "./panel.ts";
import { runJudge } from "./judge.ts";
import { runWriter, consumeStream } from "./writer.ts";
import { chatWithWebFallback } from "./web-call.ts";
import type { WebCallOptions } from "./web-call.ts";
import type { ChatGateway, GatewayClientOptions } from "../gateway/openrouter.ts";
import type {
  ExecutionPlan,
  FusionChatCompletionRequest,
  FusionConfig,
  FusionRunResult,
  FusionStage,
  GatewayCallResult,
  PanelResponse,
  WebStatus,
} from "../types.ts";

const DEFAULT_MAX_REQUEST_DURATION_MS = 180_000;

export interface RunFusionOptions {
  /** Pre-loaded config; if omitted, loadConfig() runs (reads bundled default + overrides). */
  config?: FusionConfig;
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
  onProgress?: (stage: FusionStage) => void;
  /** Stream the final answer (writer / bypass) token-by-token (CLI --stream). */
  onWriterDelta?: (delta: string) => void;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

function buildGateway(config: FusionConfig, opts: RunFusionOptions): ChatGateway {
  if (opts.gateway) return opts.gateway;
  if (!opts.apiKey) {
    throw new FusionError("gateway_error", "No gateway API key configured (set OPENROUTER_API_KEY).");
  }
  const clientOpts: GatewayClientOptions = { apiKey: opts.apiKey, baseUrl: opts.baseUrl ?? config.gateway };
  if (opts.fetch) clientOpts.fetch = opts.fetch;
  if (opts.referer) clientOpts.referer = opts.referer;
  if (opts.title) clientOpts.title = opts.title;
  if (opts.categories) clientOpts.categories = opts.categories;
  return new OpenRouterGateway(clientOpts);
}

/**
 * Best-effort cost backfill (§8.1). For any call that has a generation id but no
 * reported cost (e.g. a streamed call whose gateway omitted the usage chunk),
 * look the cost up via `/generation`. Never blocks the run; failures are ignored.
 */
async function backfillCosts(gateway: ChatGateway, calls: GatewayCallResult[]): Promise<void> {
  if (!gateway.getGeneration) return;
  const lookup = gateway.getGeneration.bind(gateway);
  await Promise.all(
    calls.map(async (call) => {
      if (!call.id || (call.usage && typeof call.usage.cost === "number")) return;
      try {
        const gen = await lookup(call.id);
        if (gen && typeof gen.cost === "number") {
          if (call.usage) call.usage.cost = gen.cost;
          else call.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: gen.cost };
        }
      } catch {
        // best-effort; ignore
      }
    }),
  );
}

function resolveWebStatus(plan: ExecutionPlan, webUsed: boolean): WebStatus {
  if (!plan.web) return "off";
  // web requested: "used" if the :online mechanism actually served a member,
  // "unsupported" if every successful member had to fall back to no-web (§15).
  return webUsed ? "used" : "unsupported";
}

export async function runFusion(
  request: FusionChatCompletionRequest,
  opts: RunFusionOptions = {},
): Promise<FusionRunResult> {
  const now = opts.now ?? Date.now;
  const startedAt = now();

  const config = opts.config ?? (await loadConfig());
  const normOpts: { runId?: string; webOverride?: boolean } = {};
  if (opts.runId) normOpts.runId = opts.runId;
  if (opts.webOverride !== undefined) normOpts.webOverride = opts.webOverride;
  const plan = normalizeRequest(request, config, normOpts); // throws invalid_request / not_a_fusion_request

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
      throw new FusionError("all_panel_failed", "All panel models failed.", { runId: plan.runId });
    }

    const prompt = renderCompactPrompt(plan.messages);

    opts.onProgress?.("judge");
    const { analysis, calls: judgeCalls } = await runJudge(plan, prompt, responses, deps);

    opts.onProgress?.("writer");
    const writerDeps = opts.onWriterDelta ? { ...deps, onDelta: opts.onWriterDelta } : deps;
    const { answer, call: writerCall } = await runWriter(plan, prompt, analysis, writerDeps);

    const allCalls = [...panelCalls, ...judgeCalls, writerCall];
    await backfillCosts(deps.gateway, allCalls);
    const { usage, costUsd } = aggregateUsage(allCalls);
    const result: FusionRunResult = {
      runId: plan.runId,
      answer,
      model: plan.writer,
      panel: responses,
      analysis,
      usage,
      costUsd,
      durationMs: now() - startedAt,
      web: resolveWebStatus(plan, webUsed),
      maxToolCallsEnforced: false,
      created: Math.floor(startedAt / 1000),
    };
    return result;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onCallerAbort);
  }
}

async function runBypass(
  plan: ExecutionPlan,
  deps: { gateway: ChatGateway; signal: AbortSignal },
  opts: RunFusionOptions,
  startedAt: number,
  now: () => number,
): Promise<FusionRunResult> {
  opts.onProgress?.("writer");

  let call: GatewayCallResult;
  let usedWeb = false;
  try {
    if (opts.onWriterDelta && deps.gateway.streamChat) {
      // Streaming bypass uses :online when web is on; no fallback while streaming.
      const req = makeChatRequest(applyWeb(plan.writer, plan.web), plan.messages, {
        temperature: plan.writerTemperature,
        maxTokens: plan.writerMaxTokens,
      });
      call = await consumeStream(deps.gateway.streamChat(req, { signal: deps.signal }), opts.onWriterDelta);
      usedWeb = plan.web;
    } else {
      const webOpts: WebCallOptions = { web: plan.web, signal: deps.signal };
      if (plan.writerTemperature !== undefined) webOpts.temperature = plan.writerTemperature;
      if (plan.writerMaxTokens !== undefined) webOpts.maxTokens = plan.writerMaxTokens;
      const out = await chatWithWebFallback(deps.gateway, plan.writer, plan.messages, webOpts);
      call = out.result;
      usedWeb = out.usedWeb;
    }
  } catch (cause) {
    throw new FusionError("writer_failed", "Single-model call failed.", { cause, runId: plan.runId });
  }
  if (!call.content || call.content.trim().length === 0) {
    throw new FusionError("writer_failed", "Single-model call returned an empty answer.", { runId: plan.runId });
  }

  await backfillCosts(deps.gateway, [call]);
  const { usage, costUsd } = aggregateUsage([call]);
  // §6.7: extras carry only run_id, duration_ms and web; omit panel/analysis.
  return {
    runId: plan.runId,
    answer: call.content,
    model: plan.writer,
    usage,
    costUsd,
    durationMs: now() - startedAt,
    web: resolveWebStatus(plan, usedWeb),
    maxToolCallsEnforced: false,
    created: Math.floor(startedAt / 1000),
  };
}

// Re-export PanelResponse for consumers importing from run.ts (type convenience).
export type { PanelResponse };
