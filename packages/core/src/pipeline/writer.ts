/**
 * Writer stage (spec §14.3).
 *
 * Produces the final user-facing answer from the prompt + judge analysis. The
 * writer does NOT use web by default (§15). Empty output or a thrown call →
 * `writer_failed` (502); the simplified judge produces no prose, so there is no
 * synthesis to fall back to (§17).
 */
import { FusionError } from "../errors.ts";
import { WRITER_SYSTEM, composeSystem, renderWriterUser } from "../prompts.ts";
import type { ChatGateway, ChatRequest } from "../gateway/openrouter.ts";
import type { ExecutionPlan, FusionAnalysis, GatewayCallResult } from "../types.ts";

export interface WriterDeps {
  gateway: ChatGateway;
  signal?: AbortSignal;
}

export interface WriterOutcome {
  answer: string;
  call: GatewayCallResult;
}

export async function runWriter(
  plan: ExecutionPlan,
  prompt: string,
  analysis: FusionAnalysis,
  deps: WriterDeps,
): Promise<WriterOutcome> {
  const systemText = composeSystem(WRITER_SYSTEM, plan.writerSystem);
  const user = renderWriterUser(prompt, JSON.stringify(analysis));

  const req: ChatRequest = {
    model: plan.writer, // writer never uses web
    messages: [
      { role: "system", content: systemText },
      { role: "user", content: user },
    ],
  };
  if (plan.writerTemperature !== undefined) req.temperature = plan.writerTemperature;
  if (plan.writerMaxTokens !== undefined) req.maxTokens = plan.writerMaxTokens;

  let call: GatewayCallResult;
  try {
    call = await deps.gateway.chat(req, deps.signal ? { signal: deps.signal } : {});
  } catch (cause) {
    throw new FusionError("writer_failed", "Writer call failed.", { cause, runId: plan.runId });
  }

  if (!call.content || call.content.trim().length === 0) {
    throw new FusionError("writer_failed", "Writer returned an empty answer.", { runId: plan.runId });
  }

  return { answer: call.content, call };
}
