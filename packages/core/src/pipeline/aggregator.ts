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
import type { ExecutionPlan, FusionixAnalysis } from "../types.ts";

/**
 * Resolve one judge-ranking entry to a surviving panel model, or undefined.
 * `survivors` MUST be in the order the judge saw them (renderAnswers order), so a
 * bare index like "2" or "[2]" maps to the second surviving answer. Tries, in order:
 * exact slug match → "[n]"/"n" index → substring match (family name, or `:online`).
 */
export function resolveRankedModel(entry: string, survivors: string[]): string | undefined {
  const e = entry.trim();
  if (e.length === 0) return undefined;
  const lower = e.toLowerCase();

  const exact = survivors.find((m) => m.toLowerCase() === lower);
  if (exact) return exact;

  // A purely numeric token is an index reference, never a substring to fuzzy-match
  // (otherwise "4" would match the "4" in "claude-opus-4.8"). Out of range → unresolved.
  const idxMatch = e.match(/^\[?(\d+)\]?$/);
  if (idxMatch) {
    const k = Number(idxMatch[1]);
    return k >= 1 && k <= survivors.length ? survivors[k - 1] : undefined;
  }

  return survivors.find((m) => {
    const ml = m.toLowerCase();
    return ml.includes(lower) || lower.includes(ml);
  });
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
