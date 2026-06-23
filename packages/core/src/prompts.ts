/**
 * Pipeline prompts (spec §14).
 *
 * The system constants are the instruction text from §14.1/§14.2/§14.3 minus
 * the inline `{{prompt}}`/`{{answers}}`/`{{analysis}}` tails — those are sent as
 * separate messages (§14.0). Preset `*System` strings are appended via
 * `composeSystem`.
 */
import type { PanelResponse } from "./types.ts";

export const PANEL_SYSTEM = `You are one expert in a panel answering the user's question independently.
Give a direct, useful answer. Be specific. If you are uncertain, state your uncertainty.
Return JSON:
{ "answer": "...", "assumptions": [], "risks": [], "citations": [] }`;

export const JUDGE_SYSTEM = `You compare several model answers to the same user question.
Do not write the final answer. Compare the answers.
Return JSON:
{ "consensus": [], "contradictions": [], "partial_coverage": [], "unique_insights": [], "blind_spots": [], "ranking": [] }`;

/**
 * Appended to the judge prompt ONLY for the `top-ranked` writer strategy (§22.2), so the
 * default judge prompt (§14.2) is unchanged byte-for-byte. It pins `ranking` to model-ids
 * so the aggregator can map the judge's #1 back to a surviving panel model.
 */
export const JUDGE_RANKING_INSTRUCTION = `Each answer is labelled "[n] <model-id>". In "ranking", list the <model-id> values (the identifier after the bracketed number, e.g. "openai/gpt-5.2"), best answer first.`;

export const CHAIN_SYSTEM = `You are one expert in a sequential chain solving the user's question step by step.
Do your assigned step well, and build on the work so far when it is provided.
Return JSON:
{ "answer": "...", "assumptions": [], "risks": [], "citations": [] }`;

export const DEBATE_SYSTEM = `You are revising your earlier answer after seeing other experts' independent answers to the same question.
Keep what is correct, adopt stronger points, and fix mistakes — but do not defer blindly; change your answer only where the others are more correct.
Return JSON:
{ "answer": "...", "assumptions": [], "risks": [], "citations": [] }`;

export const WRITER_SYSTEM = `Write the final answer to the user's question using the judge analysis.
Rules:
- Lead with the answer.
- Use consensus as high-confidence material.
- When the panel disagrees, resolve it: weigh the evidence, decide which side is correct, and state the resolution — do not merely report that a disagreement exists.
- Preserve useful unique insights.
- Do not mention the panel, judge, or internal process.`;

export function composeSystem(base: string, presetSystem?: string): string {
  const extra = (presetSystem ?? "").trim();
  return extra ? `${base}\n\n${extra}` : base;
}

function renderList(label: string, items?: string[]): string {
  if (!items || items.length === 0) return "";
  return `${label}:\n${items.map((i) => `- ${i}`).join("\n")}`;
}

/** Render successful panel answers for the judge (`{{answers}}`). Failed members are excluded. */
export function renderAnswers(panel: PanelResponse[]): string {
  const blocks: string[] = [];
  let n = 0;
  for (const p of panel) {
    if (p.error || p.answer === undefined) continue;
    n += 1;
    const sections: string[] = [`[${n}] ${p.model}`, p.answer.trim()];
    const assumptions = renderList("Assumptions", p.assumptions);
    if (assumptions) sections.push(assumptions);
    const risks = renderList("Risks", p.risks);
    if (risks) sections.push(risks);
    if (p.citations && p.citations.length > 0) {
      const cites = p.citations
        .map((c) => `- ${c.title ? `${c.title}: ` : ""}${c.url}`)
        .join("\n");
      sections.push(`Citations:\n${cites}`);
    }
    blocks.push(sections.join("\n"));
  }
  return blocks.join("\n\n---\n\n");
}

export function renderJudgeUser(prompt: string, answers: string): string {
  return `User question:\n${prompt}\n\nAnswers:\n${answers}`;
}

export function renderWriterUser(prompt: string, analysisJson: string, panelContext?: string): string {
  const base = `User question:\n${prompt}\n\nJudge analysis:\n${analysisJson}`;
  // §23.3 access-list: optionally append the panel answers the writer is granted.
  return panelContext ? `${base}\n\nPanel answers:\n${panelContext}` : base;
}
