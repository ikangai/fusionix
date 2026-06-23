/**
 * Model capability priors (Fugu-inspired; v0.9 extension — see §22).
 *
 * The Sakana Fugu technical report (Sakana AI, 2026) observes that frontier
 * models have complementary, domain-specific strengths — GPT-class models lead on
 * mathematics and competitive coding, Gemini-class on science and factual recall,
 * and Opus-class on software engineering, debugging and cybersecurity (Fugu report
 * §4.2 "Domain Adaptivity"; the qualitative build-and-debug / specialist examples
 * in §4.4). Fugu *learns* these priors by measuring per-model performance per task;
 * fusionix has no training loop, so we encode a small, COARSE, hand-maintained prior
 * here instead — the one transferable idea from Fugu's training methodology.
 *
 * These are deliberate heuristics, NOT measurements, and model slugs drift (cf.
 * config/default.config.json). They drive two opt-in features — the `capability`
 * writer-strategy (adaptive aggregator, §22.2) and the single-model router
 * (§22.4) — and never affect the default panel → judge → writer pipeline.
 */

export type Capability =
  | "coding"
  | "debugging"
  | "cybersecurity"
  | "math"
  | "science"
  | "recall"
  | "reasoning"
  | "general";

/** Provider/family substring → ordered strength tags (strongest first). */
interface FamilyPrior {
  /** Lowercased substring matched against the model slug. */
  match: string;
  strengths: Capability[];
}

// Longest match wins, so "anthropic/claude-opus" beats the generic "anthropic/claude".
const FAMILY_PRIORS: readonly FamilyPrior[] = [
  // OpenAI GPT — mathematics, planning, competitive coding (Fugu §4.1.3, §4.2).
  { match: "openai/gpt", strengths: ["math", "reasoning", "coding", "general"] },
  // Anthropic Opus — software engineering, debugging, cybersecurity (Fugu §4.4 build-and-debug / specialist).
  { match: "anthropic/claude-opus", strengths: ["coding", "debugging", "cybersecurity", "reasoning"] },
  // Other Claude families — general coding/reasoning.
  { match: "anthropic/claude", strengths: ["coding", "debugging", "reasoning", "general"] },
  // Google Gemini — science and factual recall (Fugu §4.2: chemistry/biology routed to Gemini).
  { match: "google/gemini", strengths: ["science", "recall", "reasoning", "general"] },
];

/** The provider prefix of a gateway slug (`anthropic/claude-opus-4.8` → `anthropic`). */
export function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : model;
}

/** Coarse strength tags for a model slug; `["general"]` when no family prior matches. */
export function capabilitiesFor(model: string): Capability[] {
  const slug = model.toLowerCase();
  let best: FamilyPrior | undefined;
  for (const fam of FAMILY_PRIORS) {
    if (slug.includes(fam.match) && (best === undefined || fam.match.length > best.match.length)) {
      best = fam;
    }
  }
  return best ? [...best.strengths] : ["general"];
}

/** Fit of a model to a category: its rank in the strength list (lower=better), or a penalty if absent. */
export function scoreModelForCategory(model: string, category: Capability): number {
  const caps = capabilitiesFor(model);
  const idx = caps.indexOf(category);
  return idx === -1 ? caps.length + 5 : idx;
}

/**
 * Pick the model from `models` best suited to `category`. Ties break by input
 * order (stable), so an all-"general" pool returns the first model unchanged.
 * Returns undefined only for an empty pool.
 */
export function pickBestModel(models: string[], category: Capability): string | undefined {
  if (models.length === 0) return undefined;
  let best = models[0]!;
  let bestScore = scoreModelForCategory(best, category);
  for (let i = 1; i < models.length; i++) {
    const score = scoreModelForCategory(models[i]!, category);
    if (score < bestScore) {
      best = models[i]!;
      bestScore = score;
    }
  }
  return best;
}

// Checked in order; the first category with a keyword hit wins, so the more
// specific categories (debugging, cybersecurity) precede the broader ones. Plain
// strings match as substrings; RegExp keywords (e.g. /\bcode\b/) guard short, common
// tokens against collisions like "decode" → coding.
const CATEGORY_KEYWORDS: readonly { category: Capability; words: readonly (string | RegExp)[] }[] = [
  { category: "debugging", words: ["debug", "stack trace", "stacktrace", "traceback", "segfault", "panic", "fix the bug", "why is this failing"] },
  { category: "cybersecurity", words: ["vulnerability", "exploit", "cve-", "malware", "encrypt", "decrypt", "penetration test", "xss", "sql injection", "buffer overflow", "cryptanalysis"] },
  { category: "coding", words: [/\bcode\b/, "function", "implement", "refactor", "compile", "typescript", "python", "javascript", "algorithm", "regex", "unit test"] },
  { category: "math", words: ["prove", "theorem", "integral", "derivative", "equation", "polynomial", "matrix", "probability", "algebra", "calculus", "factorial"] },
  { category: "science", words: ["chemistry", "biology", "physics", "molecule", "reaction", "protein", "quantum", "genome", "thermodynamics", "enzyme"] },
  { category: "recall", words: ["who was", "who is", "when did", "what year", "history of", "capital of", "trivia", "named after", "biography of"] },
];

/**
 * Deterministic, keyword-based category detection for the router (§22.4).
 * Coarse by design: no model call, no training — just a fast first-match scan.
 * Falls back to `general` when nothing matches.
 */
export function detectCategory(text: string): Capability {
  const t = text.toLowerCase();
  for (const { category, words } of CATEGORY_KEYWORDS) {
    if (words.some((w) => (typeof w === "string" ? t.includes(w) : w.test(t)))) return category;
  }
  return "general";
}
