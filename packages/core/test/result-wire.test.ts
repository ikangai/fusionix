import test from "node:test";
import assert from "node:assert/strict";
import { toChatCompletion } from "../src/result-wire.ts";
import type { FusionixRunResult } from "../src/types.ts";

function baseResult(overrides: Partial<FusionixRunResult> = {}): FusionixRunResult {
  return {
    runId: "fusionix-run-1",
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

test("toChatCompletion produces the OpenAI-compatible shape with fusionix extras (§6.3)", () => {
  const r = toChatCompletion(baseResult());
  assert.equal(r.object, "chat.completion");
  assert.equal(r.id, "fusionix-run-1");
  assert.equal(r.created, 1730000000);
  assert.equal(r.model, "fusionix");
  assert.equal(r.choices[0]!.index, 0);
  assert.equal(r.choices[0]!.message.role, "assistant");
  assert.equal(r.choices[0]!.message.content, "Final answer.");
  assert.equal(r.choices[0]!.finish_reason, "stop");
  assert.deepEqual(r.usage, { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 });
});

test("fusionix extras use snake_case and keep panel order with failures in place", () => {
  const { fusionix } = toChatCompletion(baseResult());
  assert.equal(fusionix.run_id, "fusionix-run-1");
  assert.equal(fusionix.cost_usd, 0.5);
  assert.equal(fusionix.duration_ms, 12000);
  assert.equal(fusionix.web, "used");
  assert.equal(fusionix.max_tool_calls_enforced, false);

  assert.equal(fusionix.panel?.[0]?.model, "A");
  assert.deepEqual(fusionix.panel?.[0]?.assumptions, ["asm"]);
  assert.deepEqual(fusionix.panel?.[0]?.citations, [{ title: "T", url: "https://x" }]);
  assert.equal(fusionix.panel?.[1]?.model, "B");
  assert.ok(fusionix.panel?.[1]?.error);
  assert.equal(fusionix.panel?.[1]?.answer, undefined);

  assert.deepEqual(fusionix.analysis?.consensus, ["c"]);
  assert.equal(fusionix.analysis?.partial_coverage[0]?.point, "p");
  assert.equal(fusionix.analysis?.unique_insights[0]?.insight, "i");
  assert.deepEqual(fusionix.analysis?.blind_spots, ["b"]);
});

test("bypass extras carry only run_id, duration_ms and web (§6.7)", () => {
  const r = toChatCompletion(baseResult({ panel: undefined, analysis: undefined, web: "off" }));
  assert.equal(r.fusionix.panel, undefined);
  assert.equal(r.fusionix.analysis, undefined);
  assert.equal(r.fusionix.web, "off");
  assert.equal(r.fusionix.run_id, "fusionix-run-1");
  assert.equal(typeof r.fusionix.duration_ms, "number");
  // §6.7: "only run_id, duration_ms, and web" — cost/usage extras are omitted.
  assert.ok(!("cost_usd" in r.fusionix), "cost_usd omitted in bypass");
  assert.ok(!("max_tool_calls_enforced" in r.fusionix), "max_tool_calls_enforced omitted in bypass");
  // Top-level OpenAI-standard usage is still present.
  assert.ok(r.usage);
  assert.equal(r.choices[0]!.message.content, "Final answer.");
});

test("cost_usd may be null", () => {
  const r = toChatCompletion(baseResult({ costUsd: null }));
  assert.equal(r.fusionix.cost_usd, null);
});

test("routed runs surface route_category and model_used; non-routed do not (§22.4)", () => {
  const routed = toChatCompletion(
    baseResult({ panel: undefined, analysis: undefined, model: "openai/gpt-5.2", routeCategory: "math" }),
  );
  assert.equal(routed.fusionix.route_category, "math");
  assert.equal(routed.fusionix.model_used, "openai/gpt-5.2");
  // A plain (non-routed) bypass result has neither field.
  const plain = toChatCompletion(baseResult({ panel: undefined, analysis: undefined }));
  assert.ok(!("route_category" in plain.fusionix), "no route_category when not routed");
  assert.ok(!("model_used" in plain.fusionix), "no model_used when not routed");
});
