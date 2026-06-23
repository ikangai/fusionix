import test from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../src/json.ts";

test("parses a clean JSON object", () => {
  assert.deepEqual(extractJson('{"answer":"hi","risks":[]}'), { answer: "hi", risks: [] });
});

test("parses a top-level JSON array", () => {
  assert.deepEqual(extractJson("[1, 2, 3]"), [1, 2, 3]);
});

test("parses JSON inside a ```json fenced block", () => {
  const text = "```json\n{\"answer\": \"fenced\"}\n```";
  assert.deepEqual(extractJson(text), { answer: "fenced" });
});

test("parses JSON inside a plain ``` fenced block", () => {
  const text = "```\n{\"answer\": \"plain fence\"}\n```";
  assert.deepEqual(extractJson(text), { answer: "plain fence" });
});

test("extracts a JSON object surrounded by prose", () => {
  const text = 'Sure! Here is my answer:\n{"answer": "wrapped", "assumptions": ["a"]}\nHope that helps.';
  assert.deepEqual(extractJson(text), { answer: "wrapped", assumptions: ["a"] });
});

test("handles braces inside strings and nested objects", () => {
  const text = 'prefix {"a":"}{ not real","b":{"c":1}} suffix';
  assert.deepEqual(extractJson(text), { a: "}{ not real", b: { c: 1 } });
});

test("handles escaped quotes inside strings", () => {
  const text = '{"answer":"she said \\"hi\\"","risks":[]}';
  assert.deepEqual(extractJson(text), { answer: 'she said "hi"', risks: [] });
});

test("returns undefined for text with no JSON", () => {
  assert.equal(extractJson("just some prose, no json here"), undefined);
});

test("returns undefined for malformed JSON", () => {
  assert.equal(extractJson('{"answer": '), undefined);
});

test("returns undefined for empty or non-string input", () => {
  assert.equal(extractJson(""), undefined);
  assert.equal(extractJson("   "), undefined);
  // @ts-expect-error testing runtime robustness
  assert.equal(extractJson(undefined), undefined);
  // @ts-expect-error testing runtime robustness
  assert.equal(extractJson(123), undefined);
});

test("prefers the earliest of object/array when both present", () => {
  const objFirst = 'note {"k":1} and [2]';
  assert.deepEqual(extractJson(objFirst), { k: 1 });
  const arrFirst = 'note [2] and {"k":1}';
  assert.deepEqual(extractJson(arrFirst), [2]);
});

test("parses a JSON array inside a fenced block", () => {
  assert.deepEqual(extractJson("```json\n[1, 2, 3]\n```"), [1, 2, 3]);
});

// Regression: BUG-4 — model output where a non-JSON balanced span (code, set notation,
// placeholders) precedes the real JSON. extractJson must scan past the failing span to the
// next opener instead of giving up on the first balanced-but-unparseable candidate. This is
// realistic output for the code-review / architecture-review presets (§5/§12, §14.1/§14.2).
test("extracts JSON that follows a brace-y code snippet in prose", () => {
  const text = 'The function `f() { return x; }` has a bug.\n\n{"answer":"fix the leak","risks":[]}';
  assert.deepEqual(extractJson(text), { answer: "fix the leak", risks: [] });
});

test("extracts JSON after set/placeholder notation containing braces", () => {
  assert.deepEqual(extractJson("The set {1,2,3} is finite.\n{\"answer\":\"ok\"}"), { answer: "ok" });
  assert.deepEqual(extractJson("Use the {placeholder} token: {\"answer\":\"ok\"}"), { answer: "ok" });
});

test("skips a non-JSON balanced span and finds the real object", () => {
  assert.deepEqual(extractJson('see {not json} but {"a":1}'), { a: 1 });
});

test("skips a non-JSON span before a real array", () => {
  assert.deepEqual(extractJson("items {a b c} then [1,2,3]"), [1, 2, 3]);
});

test("stays bounded (no quadratic blowup) on many unbalanced openers", () => {
  // Every index is an opener and the whole thing never closes — the scan must stay linear-ish.
  const n = 50000;
  const big = "{".repeat(n) + "x";
  // Warm up the JIT on a smaller input first, so the timed call measures algorithmic cost,
  // not one-time compilation (timing a single cold call is otherwise flaky on a loaded VM).
  assert.equal(extractJson("{".repeat(1000) + "x"), undefined);
  const start = process.hrtime.bigint();
  const result = extractJson(big);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(result, undefined);
  // Linear is ~0.2s warm; quadratic on 50k openers would be tens of seconds. A wide ceiling
  // catches a real regression decisively while tolerating a loaded VM running tests in parallel.
  assert.ok(ms < 3000, `extractJson took ${ms.toFixed(0)}ms (possible quadratic blowup)`);
});

test("returns quickly (no ReDoS) for a large unterminated fence", () => {
  // A fence that opens but never validly closes, with many newlines. The old
  // lazy-regex stripper backtracked quadratically here; this must stay linear.
  const big = "```\n" + "\n".repeat(200000) + "x";
  const start = process.hrtime.bigint();
  const result = extractJson(big);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(result, undefined);
  assert.ok(ms < 500, `extractJson took ${ms.toFixed(0)}ms (possible ReDoS)`);
});
