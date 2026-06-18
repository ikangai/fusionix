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
import { makeChatRequest } from "../gateway/openrouter.ts";
import type { ChatGateway } from "../gateway/openrouter.ts";
import type { ExecutionPlan, FusionAnalysis, GatewayCallResult } from "../types.ts";

export interface WriterDeps {
  gateway: ChatGateway;
  signal?: AbortSignal;
  /** When set and the gateway supports streaming, the writer streams deltas here. */
  onDelta?: (delta: string) => void;
}

export interface WriterOutcome {
  answer: string;
  call: GatewayCallResult;
}

export async function consumeStream(
  gen: AsyncGenerator<string, GatewayCallResult, void>,
  onDelta: (delta: string) => void,
): Promise<GatewayCallResult> {
  let next = await gen.next();
  while (!next.done) {
    onDelta(next.value);
    next = await gen.next();
  }
  return next.value;
}

export async function runWriter(
  plan: ExecutionPlan,
  prompt: string,
  analysis: FusionAnalysis,
  deps: WriterDeps,
): Promise<WriterOutcome> {
  const systemText = composeSystem(WRITER_SYSTEM, plan.writerSystem);
  const user = renderWriterUser(prompt, JSON.stringify(analysis));

  // Writer never uses web.
  const req = makeChatRequest(
    plan.writer,
    [
      { role: "system", content: systemText },
      { role: "user", content: user },
    ],
    { temperature: plan.writerTemperature, maxTokens: plan.writerMaxTokens },
  );

  const callOpts = deps.signal ? { signal: deps.signal } : {};
  let call: GatewayCallResult;
  try {
    if (deps.onDelta && deps.gateway.streamChat) {
      call = await consumeStream(deps.gateway.streamChat(req, callOpts), deps.onDelta);
    } else {
      call = await deps.gateway.chat(req, callOpts);
    }
  } catch (cause) {
    throw new FusionError("writer_failed", "Writer call failed.", { cause, runId: plan.runId });
  }

  if (!call.content || call.content.trim().length === 0) {
    throw new FusionError("writer_failed", "Writer returned an empty answer.", { runId: plan.runId });
  }

  return { answer: call.content, call };
}
