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

function stripFence(s: string): string {
  const m = s.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  return m ? (m[1] as string) : s;
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

/** Find the first balanced JSON object/array candidate, choosing the earliest opener. */
function firstCandidate(text: string): string | undefined {
  const objIdx = text.indexOf("{");
  const arrIdx = text.indexOf("[");
  let start = -1;
  let open = "{";
  let close = "}";
  if (objIdx >= 0 && (arrIdx < 0 || objIdx < arrIdx)) {
    start = objIdx;
    open = "{";
    close = "}";
  } else if (arrIdx >= 0) {
    start = arrIdx;
    open = "[";
    close = "]";
  }
  if (start < 0) return undefined;
  return balancedFrom(text, start, open, close);
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

  // 3. Scan for the first balanced object/array (handles JSON embedded in prose).
  const candidate = firstCandidate(unfenced);
  if (candidate !== undefined) {
    const parsed = tryParse(candidate);
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}
