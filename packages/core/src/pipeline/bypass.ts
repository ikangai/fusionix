/**
 * Single-model bypass (spec §6.7, §17).
 *
 * When the fusionix plugin is disabled (`enabled: false`) the request runs as a
 * plain single-model call — no panel/judge/writer. Unlike the deliberation writer
 * (§15) the bypass MAY use web: when streaming it calls the `:online` variant
 * directly with no fallback; otherwise it goes through `chatWithWebFallback` so a
 * web-routing failure degrades to `web: "unsupported"` rather than failing the run.
 * Empty content or a thrown call → `writer_failed`. Extras carry only
 * run_id/duration_ms/web (§6.7), so panel/analysis are omitted.
 */
import { finalizeCost } from "../cost.ts";
import { FusionixError } from "../errors.ts";
import { applyWeb, webStatus } from "../gateway/web.ts";
import { makeChatRequest, consumeStream } from "../gateway/contract.ts";
import { chatWithWebFallback } from "./web-call.ts";
import type { WebCallOptions } from "./web-call.ts";
import type { ChatGateway } from "../gateway/contract.ts";
import type { ExecutionPlan, FusionixRunResult, FusionixStage, GatewayCallResult } from "../types.ts";

export interface BypassDeps {
  gateway: ChatGateway;
  signal: AbortSignal;
}

export interface BypassOptions {
  onProgress?: (stage: FusionixStage) => void;
  /** Stream the answer token-by-token (CLI --stream). */
  onWriterDelta?: (delta: string) => void;
}

export async function runBypass(
  plan: ExecutionPlan,
  deps: BypassDeps,
  opts: BypassOptions,
  startedAt: number,
  now: () => number,
): Promise<FusionixRunResult> {
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
    throw new FusionixError("writer_failed", "Single-model call failed.", { cause, runId: plan.runId });
  }
  if (!call.content || call.content.trim().length === 0) {
    throw new FusionixError("writer_failed", "Single-model call returned an empty answer.", { runId: plan.runId });
  }

  const { usage, costUsd } = await finalizeCost(deps.gateway, [call]);
  // §6.7: extras carry only run_id, duration_ms and web; omit panel/analysis.
  return {
    runId: plan.runId,
    answer: call.content,
    model: plan.writer,
    usage,
    costUsd,
    durationMs: now() - startedAt,
    web: webStatus(plan.web, usedWeb),
    maxToolCallsEnforced: false,
    created: Math.floor(startedAt / 1000),
  };
}
