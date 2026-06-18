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
import { OpenRouterGateway } from "../gateway/openrouter.ts";
import { runPanel } from "./panel.ts";
import { runJudge } from "./judge.ts";
import { runWriter } from "./writer.ts";
import type { ChatGateway, ChatRequest, GatewayClientOptions } from "../gateway/openrouter.ts";
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

function resolveWebStatus(plan: ExecutionPlan, panelSuccessCount: number): WebStatus {
  if (!plan.web) return "off";
  // v1 uses OpenRouter :online (universally available). "used" = mechanism enabled and the
  // pipeline produced output; "unsupported" is reserved for when no member could use it.
  return panelSuccessCount > 0 ? "used" : "unsupported";
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
    const { responses, calls: panelCalls } = await runPanel(plan, deps);
    const successes = responses.filter((r) => r.error === undefined && r.answer !== undefined);
    if (successes.length === 0) {
      throw new FusionError("all_panel_failed", "All panel models failed.", { runId: plan.runId });
    }

    const prompt = renderCompactPrompt(plan.messages);

    opts.onProgress?.("judge");
    const { analysis, calls: judgeCalls } = await runJudge(plan, prompt, responses, deps);

    opts.onProgress?.("writer");
    const { answer, call: writerCall } = await runWriter(plan, prompt, analysis, deps);

    const { usage, costUsd } = aggregateUsage([...panelCalls, ...judgeCalls, writerCall]);
    const result: FusionRunResult = {
      runId: plan.runId,
      answer,
      model: plan.writer,
      panel: responses,
      analysis,
      usage,
      costUsd,
      durationMs: now() - startedAt,
      web: resolveWebStatus(plan, successes.length),
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
  const req: ChatRequest = { model: applyWeb(plan.writer, plan.web), messages: plan.messages };
  if (plan.writerTemperature !== undefined) req.temperature = plan.writerTemperature;
  if (plan.writerMaxTokens !== undefined) req.maxTokens = plan.writerMaxTokens;

  let call: GatewayCallResult;
  try {
    call = await deps.gateway.chat(req, { signal: deps.signal });
  } catch (cause) {
    throw new FusionError("writer_failed", "Single-model call failed.", { cause, runId: plan.runId });
  }
  if (!call.content || call.content.trim().length === 0) {
    throw new FusionError("writer_failed", "Single-model call returned an empty answer.", { runId: plan.runId });
  }

  const { usage, costUsd } = aggregateUsage([call]);
  // §6.7: extras carry only run_id, duration_ms and web; omit panel/analysis.
  return {
    runId: plan.runId,
    answer: call.content,
    model: plan.writer,
    usage,
    costUsd,
    durationMs: now() - startedAt,
    web: plan.web ? "used" : "off",
    maxToolCallsEnforced: false,
    created: Math.floor(startedAt / 1000),
  };
}

// Re-export PanelResponse for consumers importing from run.ts (type convenience).
export type { PanelResponse };
