/**
 * Adaptive aggregator — choose the writer model after the judge (v0.9 §22.2).
 *
 * The Sakana Fugu report identifies the central weakness of a fixed-aggregator
 * deliberation system (which it names, citing OpenRouter Fusion): a single model
 * always synthesizes the final answer, so the system is bottlenecked by that
 * model's competence on tasks outside its strengths (Fugu report §4.4). Fugu-Ultra
 * instead picks the aggregator per query — Gemini for trivia, GPT for math.
 *
 * fusionix mirrors this at the writer stage. When a strategy other than "fixed" is
 * set, this module selects the writer from the SURVIVING panel models (the ones the
 * judge actually saw), so the strongest model for this query writes the answer:
 *  - "top-ranked": the judge's #1 ranked surviving model;
 *  - "capability": the surviving panelist best-suited to the detected category.
 * It always falls back to the configured `plan.writer` when it cannot resolve a
 * model, so a vague judge ranking or a category-less prompt never breaks the run.
 */
import { pickBestModel, detectCategory } from "../capabilities.ts";
import { userTurnsText } from "../messages.ts";
import { renderAnswers } from "../prompts.ts";
import type { ExecutionPlan, FusionixAnalysis, PanelResponse } from "../types.ts";

/**
 * Resolve one judge-ranking entry to a surviving panel model, or undefined.
 * `survivors` MUST be in the order the judge saw them (renderAnswers order), so a
 * bare index like "2" or "[2]" maps to the second surviving answer. Tries, in order:
 * exact slug match → "[n]"/"n" index → substring match (family name, or `:online`).
 */
export function resolveRankedModel(entry: string, survivors: string[]): string | undefined {
  const i = resolveRankedIndex(entry, survivors);
  return i !== undefined ? survivors[i] : undefined;
}

/**
 * Like {@link resolveRankedModel} but returns the matched POSITION, so callers that hold the
 * full survivor objects can select the exact entry even when the panel repeats a model slug
 * (a bare `[2]` selects the second survivor, not the first with that slug).
 */
export function resolveRankedIndex(entry: string, models: string[]): number | undefined {
  const e = entry.trim();
  if (e.length === 0) return undefined;
  const lower = e.toLowerCase();

  const exact = models.findIndex((m) => m.toLowerCase() === lower);
  if (exact !== -1) return exact;

  // A purely numeric token is an index reference, never a substring to fuzzy-match
  // (otherwise "4" would match the "4" in "claude-opus-4.8"). Out of range → unresolved.
  const idxMatch = e.match(/^\[?(\d+)\]?$/);
  if (idxMatch) {
    const k = Number(idxMatch[1]);
    return k >= 1 && k <= models.length ? k - 1 : undefined;
  }

  const sub = models.findIndex((m) => {
    const ml = m.toLowerCase();
    return ml.includes(lower) || lower.includes(ml);
  });
  return sub !== -1 ? sub : undefined;
}

/**
 * Choose the writer model for this run. Returns `plan.writer` for the default
 * "fixed" strategy (or when nothing resolves), otherwise an adaptively-selected
 * surviving panel model. The "capability" branch classifies the user's question
 * only (via userTurnsText), matching the router (§22.4), so fixed persona/system
 * text never drives writer selection.
 */
export function chooseWriter(plan: ExecutionPlan, analysis: FusionixAnalysis, survivors: string[]): string {
  if (survivors.length === 0) return plan.writer;

  switch (plan.writerStrategy) {
    case "top-ranked": {
      for (const entry of analysis.ranking) {
        const resolved = resolveRankedModel(entry, survivors);
        if (resolved) return resolved;
      }
      return plan.writer;
    }
    case "capability": {
      const category = detectCategory(userTurnsText(plan.messages));
      // No category signal → keep the configured writer rather than guessing.
      if (category === "general") return plan.writer;
      return pickBestModel(survivors, category) ?? plan.writer;
    }
    default:
      return plan.writer;
  }
}

/**
 * Verifier accept-gate (v0.10 §23.1; TRINITY §3.2). When the judge reports full
 * consensus — no contradictions AND no blind spots — accept the strongest surviving
 * panelist's answer directly and skip the writer synthesis, saving a model call.
 * Returns the accepted panel response (the judge's #1 ranked survivor if its ranking
 * resolves, else the first survivor), or undefined when the gate does not fire.
 * `survivors` are the surviving panel responses (each with a defined `answer`).
 */
export function acceptTopOnConsensus(
  analysis: FusionixAnalysis,
  survivors: PanelResponse[],
): PanelResponse | undefined {
  if (survivors.length === 0) return undefined;
  if (analysis.contradictions.length > 0 || analysis.blindSpots.length > 0) return undefined;
  return pickTopSurvivor(analysis, survivors);
}

/** The judge's #1 ranked survivor (else the first survivor); undefined for an empty pool. */
function pickTopSurvivor(analysis: FusionixAnalysis, survivors: PanelResponse[]): PanelResponse | undefined {
  if (survivors.length === 0) return undefined;
  const models = survivors.map((s) => s.model);
  for (const entry of analysis.ranking) {
    // Resolve POSITIONALLY so a duplicate-slug panel keeps each entry's identity.
    const idx = resolveRankedIndex(entry, models);
    if (idx !== undefined) return survivors[idx];
  }
  return survivors[0];
}

/**
 * Access-list writer context (v0.10 §23.3; Conductor's `access_list` = pure prompt-string
 * selection). Returns the extra panel text the writer should see beyond the judge analysis,
 * per `plan.writerAccess`: "judge+panel" → all surviving answers; "judge+top" → only the
 * top-ranked survivor's answer; default ("judge") → undefined (analysis only, unchanged).
 */
export function writerPanelContext(
  plan: ExecutionPlan,
  analysis: FusionixAnalysis,
  survivors: PanelResponse[],
): string | undefined {
  if (survivors.length === 0) return undefined;
  switch (plan.writerAccess) {
    case "judge+panel":
      return renderAnswers(survivors);
    case "judge+top": {
      const top = pickTopSurvivor(analysis, survivors);
      return top ? renderAnswers([top]) : undefined;
    }
    default:
      return undefined;
  }
}
