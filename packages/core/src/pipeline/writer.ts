/**
 * Writer stage (spec §14.3).
 *
 * Produces the final user-facing answer from the prompt + judge analysis. The
 * writer does NOT use web by default (§15). Empty output or a thrown call →
 * `writer_failed` (502); the simplified judge produces no prose, so there is no
 * synthesis to fall back to (§17).
 */
import { FusionixError } from "../errors.ts";
import { WRITER_SYSTEM, composeSystem, renderWriterUser } from "../prompts.ts";
import { makeChatRequest, consumeStream } from "../gateway/contract.ts";
import type { ChatGateway } from "../gateway/contract.ts";
import type { ExecutionPlan, FusionixAnalysis, GatewayCallResult } from "../types.ts";

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

export async function runWriter(
  plan: ExecutionPlan,
  prompt: string,
  analysis: FusionixAnalysis,
  deps: WriterDeps,
  /** Extra panel context per the access-list (§23.3); undefined = judge analysis only. */
  panelContext?: string,
): Promise<WriterOutcome> {
  const systemText = composeSystem(WRITER_SYSTEM, plan.writerSystem);
  const user = renderWriterUser(prompt, JSON.stringify(analysis), panelContext);

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
    throw new FusionixError("writer_failed", "Writer call failed.", { cause, runId: plan.runId });
  }

  if (!call.content || call.content.trim().length === 0) {
    throw new FusionixError("writer_failed", "Writer returned an empty answer.", { runId: plan.runId });
  }

  return { answer: call.content, call };
}
