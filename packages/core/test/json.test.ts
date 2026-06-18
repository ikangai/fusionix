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
