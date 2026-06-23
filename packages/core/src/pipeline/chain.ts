/**
 * Chain topology (v0.10 §23.4; Conductor §F.1).
 *
 * A sequential planner → builder(s) → finalizer pipeline: the panel models run IN ORDER,
 * each seeing the accumulated work of the prior steps, and the last successful step's answer
 * is the final answer. This is the asymmetric, staged hand-off the Conductor's data shows
 * wins on hard, multi-step tasks (Fig. 8) — a different graph from the parallel panel and
 * from the symmetric `debate` round. No judge or writer stage runs in chain mode.
 *
 * Like the panel, a chain step may use web (chatWithWebFallback). A step that fails or
 * returns empty is kept in place as a failed entry; the chain continues with the work so far,
 * and the final answer is the last step that did produce content.
 */
import { finalizeCost } from "../cost.ts";
import { FusionixError } from "../errors.ts";
import { renderCompactPrompt } from "../messages.ts";
import { webStatus } from "../gateway/web.ts";
import { CHAIN_SYSTEM, composeSystem } from "../prompts.ts";
import { chatWithWebFallback } from "../gateway/web-call.ts";
import { parsePanelContent } from "./panel.ts";
import type { WebCallOptions } from "../gateway/web-call.ts";
import type { ChatGateway } from "../gateway/contract.ts";
import type { ExecutionPlan, FusionixRunResult, FusionixStage, GatewayCallResult, PanelResponse } from "../types.ts";

export interface ChainDeps {
  gateway: ChatGateway;
  signal: AbortSignal;
}

export interface ChainOptions {
  onProgress?: (stage: FusionixStage) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-position role instruction injected into the step's user message. */
function roleInstruction(index: number, total: number): string {
  if (total === 1) return "Produce the complete final answer to the question.";
  if (index === 0) return "You are the PLANNER. Outline a clear, concrete approach to the question. Do not yet write the full final answer.";
  if (index === total - 1) return "You are the FINALIZER. Produce the complete, polished final answer to the question, using the work so far.";
  return "You are a BUILDER. Extend and improve the work so far toward a complete, correct solution.";
}

export async function runChain(
  plan: ExecutionPlan,
  deps: ChainDeps,
  opts: ChainOptions,
  startedAt: number,
  now: () => number,
): Promise<FusionixRunResult> {
  const prompt = renderCompactPrompt(plan.messages);
  const systemText = composeSystem(CHAIN_SYSTEM, plan.panelSystem);
  const models = plan.panel;

  const steps: PanelResponse[] = [];
  const calls: GatewayCallResult[] = [];
  let webUsed = false;
  let context = "";

  for (let i = 0; i < models.length; i++) {
    opts.onProgress?.("chain");
    const model = models[i]!;
    const user =
      `${roleInstruction(i, models.length)}\n\nUser question:\n${prompt}` +
      (context ? `\n\nWork so far:\n${context}` : "");
    const webOpts: WebCallOptions = { web: plan.web };
    if (plan.panelTemperature !== undefined) webOpts.temperature = plan.panelTemperature;
    if (plan.panelMaxTokens !== undefined) webOpts.maxTokens = plan.panelMaxTokens;
    webOpts.signal = deps.signal;
    try {
      const { result, usedWeb } = await chatWithWebFallback(
        deps.gateway,
        model,
        [
          { role: "system", content: systemText },
          { role: "user", content: user },
        ],
        webOpts,
      );
      // The call succeeded; count it for cost regardless of content (mirrors the panel).
      calls.push(result);
      if (!result.content || result.content.trim().length === 0) {
        steps.push({ model, error: { message: "Model returned an empty response." } });
        continue;
      }
      const step = parsePanelContent(model, result.content);
      steps.push(step);
      if (usedWeb) webUsed = true;
      context += `\n[${model}] ${step.answer ?? ""}`;
    } catch (err) {
      steps.push({ model, error: { message: errorMessage(err) } });
    }
  }

  // The final answer is the last step that produced content.
  const finalStep = [...steps].reverse().find((s) => s.error === undefined && s.answer !== undefined && s.answer.trim().length > 0);
  if (!finalStep?.answer) {
    throw new FusionixError("all_panel_failed", "All chain steps failed.", { runId: plan.runId });
  }

  const { usage, costUsd } = await finalizeCost(deps.gateway, calls);
  // The answering call is the last one (the finalizer step that produced content).
  const finishReason = calls[calls.length - 1]?.finishReason;
  const result: FusionixRunResult = {
    runId: plan.runId,
    answer: finalStep.answer,
    model: finalStep.model,
    panel: steps,
    usage,
    costUsd,
    durationMs: now() - startedAt,
    web: webStatus(plan.web, webUsed),
    maxToolCallsEnforced: false,
    created: Math.floor(startedAt / 1000),
  };
  if (finishReason) result.finishReason = finishReason;
  return result;
}
