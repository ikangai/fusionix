/**
 * Debate topology (v0.9 §22.5).
 *
 * One inter-panel revision round inserted between panel and judge. Each surviving
 * panelist sees the other experts' first answers and revises its own; the revised
 * answers replace the round-1 answers for the judge and the final result. The Sakana
 * Fugu report (§4.4 "Debate and aggregation") finds multi-round/debate topologies
 * raise collective knowledge on hard, knowledge-intensive questions — the kind of
 * coordination a fixed panel→judge→writer pipeline cannot express.
 *
 * Like the writer, debate does NOT use web (§15): it reasons over peer answers, not
 * fresh retrieval. A revision that fails or comes back empty keeps the round-1 answer,
 * so a debate round can only improve or preserve the panel, never lose a survivor.
 */
import { prependSystem } from "../messages.ts";
import { DEBATE_SYSTEM, composeSystem, renderAnswers } from "../prompts.ts";
import { makeChatRequest } from "../gateway/contract.ts";
import { parsePanelContent } from "./panel.ts";
import type { ChatGateway } from "../gateway/contract.ts";
import type { ExecutionPlan, GatewayCallResult, PanelResponse } from "../types.ts";

export interface DebateDeps {
  gateway: ChatGateway;
  signal?: AbortSignal;
}

export interface DebateOutcome {
  /** The panel after revision, in the original order (failed members kept in place). */
  responses: PanelResponse[];
  /** Successful revision calls, for cost aggregation. */
  calls: GatewayCallResult[];
}

export async function runDebate(
  plan: ExecutionPlan,
  prompt: string,
  responses: PanelResponse[],
  deps: DebateDeps,
): Promise<DebateOutcome> {
  const survivors = responses.filter((r) => r.error === undefined && r.answer !== undefined);
  // A debate needs at least two views to be worth a round.
  if (survivors.length < 2) return { responses, calls: [] };

  const systemText = composeSystem(DEBATE_SYSTEM, plan.panelSystem);
  const answersBlock = renderAnswers(survivors);
  const signalOpts = deps.signal ? { signal: deps.signal } : {};

  const settled = await Promise.all(
    survivors.map(async (s) => {
      const user =
        `User question:\n${prompt}\n\n` +
        `The panel's first answers:\n${answersBlock}\n\n` +
        `You are ${s.model}. Revise your own answer in light of the others. Return the same JSON shape.`;
      // prependSystem folds caller roles, but here we send only the debate instruction
      // and a single user message (the question + peer answers), like the judge/writer.
      const req = makeChatRequest(s.model, prependSystem(systemText, [{ role: "user", content: user }]), {
        temperature: plan.panelTemperature,
        maxTokens: plan.panelMaxTokens,
      });
      try {
        const res = await deps.gateway.chat(req, signalOpts);
        return { model: s.model, ok: true as const, res };
      } catch {
        return { model: s.model, ok: false as const };
      }
    }),
  );

  const revisedByModel = new Map<string, PanelResponse>();
  const calls: GatewayCallResult[] = [];
  for (const outcome of settled) {
    if (!outcome.ok) continue; // revision failed → keep the round-1 answer
    calls.push(outcome.res);
    if (outcome.res.content && outcome.res.content.trim().length > 0) {
      revisedByModel.set(outcome.model, parsePanelContent(outcome.model, outcome.res.content));
    }
    // empty revision → keep round-1 (don't overwrite)
  }

  const revised = responses.map((r) => revisedByModel.get(r.model) ?? r);
  return { responses: revised, calls };
}
