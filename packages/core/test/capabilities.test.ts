import test from "node:test";
import assert from "node:assert/strict";
import {
  providerOf,
  capabilitiesFor,
  scoreModelForCategory,
  pickBestModel,
  detectCategory,
} from "../src/capabilities.ts";

test("providerOf extracts the provider prefix, or returns the slug when unprefixed", () => {
  assert.equal(providerOf("anthropic/claude-opus-4.8"), "anthropic");
  assert.equal(providerOf("openai/gpt-5.2"), "openai");
  assert.equal(providerOf("gpt-5.2"), "gpt-5.2");
});

test("capabilitiesFor uses the longest matching family prior (opus beats generic claude)", () => {
  const opus = capabilitiesFor("anthropic/claude-opus-4.8");
  assert.equal(opus[0], "coding");
  assert.ok(opus.includes("cybersecurity"), "opus prior includes cybersecurity");
  // Generic claude (haiku) does NOT get the opus-only cybersecurity tag.
  const haiku = capabilitiesFor("anthropic/claude-haiku-4.5");
  assert.ok(!haiku.includes("cybersecurity"), "haiku is not tagged cybersecurity");
});

test("capabilitiesFor maps GPT→math-first and Gemini→science-first (§22 Fugu priors)", () => {
  assert.equal(capabilitiesFor("openai/gpt-5.2")[0], "math");
  assert.equal(capabilitiesFor("google/gemini-3.1-pro-preview")[0], "science");
});

test("v0.10: priors reconciled with TRINITY winners — Gemini gains math, Claude gains recall", () => {
  // TRINITY Table 1: Gemini-2.5-pro tops MATH500; Claude tops MMLU (recall).
  assert.ok(capabilitiesFor("google/gemini-3.1-pro-preview").includes("math"), "Gemini is a math contender");
  assert.ok(capabilitiesFor("anthropic/claude-haiku-4.5").includes("recall"), "Claude handles recall");
  // But GPT still wins a pure math route (math at index 0 beats Gemini's later position).
  assert.equal(pickBestModel(["google/gemini-3.1-pro-preview", "openai/gpt-5.2"], "math"), "openai/gpt-5.2");
});

test("capabilitiesFor falls back to general for unknown slugs", () => {
  assert.deepEqual(capabilitiesFor("mistral/mixtral"), ["general"]);
});

test("scoreModelForCategory ranks a strength by position, penalizes absent categories", () => {
  // gpt strengths: math, reasoning, coding, general
  assert.equal(scoreModelForCategory("openai/gpt-5.2", "math"), 0);
  assert.equal(scoreModelForCategory("openai/gpt-5.2", "coding"), 2);
  assert.ok(scoreModelForCategory("openai/gpt-5.2", "science") > 3, "absent category penalized");
});

test("pickBestModel chooses the model best suited to a category", () => {
  const pool = ["anthropic/claude-opus-4.8", "openai/gpt-5.2", "google/gemini-3.1-pro-preview"];
  assert.equal(pickBestModel(pool, "math"), "openai/gpt-5.2");
  assert.equal(pickBestModel(pool, "science"), "google/gemini-3.1-pro-preview");
  assert.equal(pickBestModel(pool, "debugging"), "anthropic/claude-opus-4.8");
});

test("pickBestModel breaks ties by input order and returns undefined for an empty pool", () => {
  // No model has a 'recall' strength except gemini; for an all-general pool, first wins.
  assert.equal(pickBestModel(["x/one", "y/two"], "coding"), "x/one");
  assert.equal(pickBestModel([], "math"), undefined);
});

test("detectCategory matches the most specific category first", () => {
  assert.equal(detectCategory("Help me debug this stack trace"), "debugging");
  assert.equal(detectCategory("Write an exploit for this CVE-2026-1 vulnerability"), "cybersecurity");
  assert.equal(detectCategory("Implement a binary search function in TypeScript"), "coding");
  assert.equal(detectCategory("Prove the theorem about polynomial roots"), "math");
  assert.equal(detectCategory("Explain the chemistry of this enzyme reaction"), "science");
  assert.equal(detectCategory("Who was the first president?"), "recall");
  assert.equal(detectCategory("Tell me a story about a dog"), "general");
});

test("detectCategory uses a word boundary for 'code' (no 'decode'/'barcode' false positives)", () => {
  assert.equal(detectCategory("Decode this base64 string"), "general");
  assert.equal(detectCategory("What does a barcode encode?"), "general");
  assert.equal(detectCategory("Write code for a linked list"), "coding");
});
