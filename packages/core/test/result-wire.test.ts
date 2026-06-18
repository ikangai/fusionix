import test from "node:test";
import assert from "node:assert/strict";
import { toChatCompletion } from "../src/result-wire.ts";
import type { FusionRunResult } from "../src/types.ts";

function baseResult(overrides: Partial<FusionRunResult> = {}): FusionRunResult {
  return {
    runId: "fusion-run-1",
    answer: "Final answer.",
    model: "anthropic/claude-opus-4.8",
    panel: [
      { model: "A", answer: "a", assumptions: ["asm"], risks: ["r"], citations: [{ title: "T", url: "https://x" }] },
      { model: "B", error: { message: "boom" } },
    ],
    analysis: {
      consensus: ["c"],
      contradictions: [{ topic: "t", stances: [{ model: "A", stance: "s" }] }],
      partialCoverage: [{ models: ["A"], point: "p" }],
      uniqueInsights: [{ model: "B", insight: "i" }],
      blindSpots: ["b"],
      ranking: ["A", "B"],
    },
    usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
    costUsd: 0.5,
    durationMs: 12000,
    web: "used",
    maxToolCallsEnforced: false,
    created: 1730000000,
    ...overrides,
  };
}

test("toChatCompletion produces the OpenAI-compatible shape with fusion extras (§6.3)", () => {
  const r = toChatCompletion(baseResult());
  assert.equal(r.object, "chat.completion");
  assert.equal(r.id, "fusion-run-1");
  assert.equal(r.created, 1730000000);
  assert.equal(r.model, "fusion");
  assert.equal(r.choices[0]!.index, 0);
  assert.equal(r.choices[0]!.message.role, "assistant");
  assert.equal(r.choices[0]!.message.content, "Final answer.");
  assert.equal(r.choices[0]!.finish_reason, "stop");
  assert.deepEqual(r.usage, { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 });
});

test("fusion extras use snake_case and keep panel order with failures in place", () => {
  const { fusion } = toChatCompletion(baseResult());
  assert.equal(fusion.run_id, "fusion-run-1");
  assert.equal(fusion.cost_usd, 0.5);
  assert.equal(fusion.duration_ms, 12000);
  assert.equal(fusion.web, "used");
  assert.equal(fusion.max_tool_calls_enforced, false);

  assert.equal(fusion.panel?.[0]?.model, "A");
  assert.deepEqual(fusion.panel?.[0]?.assumptions, ["asm"]);
  assert.deepEqual(fusion.panel?.[0]?.citations, [{ title: "T", url: "https://x" }]);
  assert.equal(fusion.panel?.[1]?.model, "B");
  assert.ok(fusion.panel?.[1]?.error);
  assert.equal(fusion.panel?.[1]?.answer, undefined);

  assert.deepEqual(fusion.analysis?.consensus, ["c"]);
  assert.equal(fusion.analysis?.partial_coverage[0]?.point, "p");
  assert.equal(fusion.analysis?.unique_insights[0]?.insight, "i");
  assert.deepEqual(fusion.analysis?.blind_spots, ["b"]);
});

test("bypass extras carry only run_id, duration_ms and web (§6.7)", () => {
  const r = toChatCompletion(baseResult({ panel: undefined, analysis: undefined, web: "off" }));
  assert.equal(r.fusion.panel, undefined);
  assert.equal(r.fusion.analysis, undefined);
  assert.equal(r.fusion.web, "off");
  assert.equal(r.fusion.run_id, "fusion-run-1");
  assert.equal(typeof r.fusion.duration_ms, "number");
  // §6.7: "only run_id, duration_ms, and web" — cost/usage extras are omitted.
  assert.ok(!("cost_usd" in r.fusion), "cost_usd omitted in bypass");
  assert.ok(!("max_tool_calls_enforced" in r.fusion), "max_tool_calls_enforced omitted in bypass");
  // Top-level OpenAI-standard usage is still present.
  assert.ok(r.usage);
  assert.equal(r.choices[0]!.message.content, "Final answer.");
});

test("cost_usd may be null", () => {
  const r = toChatCompletion(baseResult({ costUsd: null }));
  assert.equal(r.fusion.cost_usd, null);
});
