/**
 * Lenient JSON extraction for model output.
 *
 * Models often wrap JSON in prose or markdown fences. `extractJson` tries, in
 * order: a direct parse, a fenced-block parse, then a string/escape-aware scan
 * for the first balanced object or array.
 *
 * Returns `undefined` only when nothing parseable is found. JSON.parse never
 * yields `undefined`, so `undefined` unambiguously means "no JSON".
 */

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Strip a wrapping markdown code fence with a LINEAR scan (no regex backtracking).
 * Only treats the input as fenced when it both opens with ``` on the first line
 * and ends with ```; otherwise returns it unchanged. Untrusted model output of
 * arbitrary size flows through here, so this must not be super-linear.
 */
function stripFence(s: string): string {
  if (!s.startsWith("```") || !s.endsWith("```") || s.length < 6) return s;
  const firstNewline = s.indexOf("\n");
  if (firstNewline === -1) return s;
  const lang = s.slice(3, firstNewline).trim();
  // The fence info string (if any) must look like a language tag.
  if (lang.length > 0 && !/^[a-zA-Z0-9_-]+$/.test(lang)) return s;
  const inner = s.slice(firstNewline + 1, s.length - 3);
  return inner.endsWith("\n") ? inner.slice(0, -1) : inner;
}

/** Scan from `start` (an opening bracket) to its matching close, honoring strings/escapes. */
function balancedFrom(text: string, start: number, open: string, close: string): string | undefined {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

// Bound the candidate scan so pathological input (e.g. thousands of unbalanced
// `{`) cannot make extraction super-linear. Realistic model output has only a
// handful of brace spans before the JSON block, so this is never hit in practice.
const MAX_JSON_CANDIDATES = 200;

/**
 * Scan `{`/`[` openers earliest-first and return the first balanced span that
 * actually parses. Models routinely emit code, set notation, or placeholders
 * (`f() { return x; }`, `{1,2,3}`, `{placeholder}`) BEFORE their JSON block, so a
 * balanced-but-unparseable candidate must not abort the search — we advance to the
 * next opener instead of giving up (spec §14.1/§14.2 lenient extraction).
 */
function scanForJson(text: string): unknown | undefined {
  let tried = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    if (++tried > MAX_JSON_CANDIDATES) break;
    const candidate = balancedFrom(text, i, ch, ch === "{" ? "}" : "]");
    if (candidate !== undefined) {
      const parsed = tryParse(candidate);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

export function extractJson(text: unknown): unknown | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // 1. Direct parse.
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  // 2. Strip a wrapping markdown fence, then parse.
  const unfenced = stripFence(trimmed).trim();
  if (unfenced !== trimmed) {
    const parsed = tryParse(unfenced);
    if (parsed !== undefined) return parsed;
  }

  // 3. Scan balanced object/array candidates earliest-first (handles JSON embedded
  // in prose, including non-JSON brace spans that precede the real block).
  return scanForJson(unfenced);
}
