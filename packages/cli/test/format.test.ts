import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, renderText, renderJson } from "../src/format.ts";
import type { FusionRunResult } from "@ikangai/fusion-core";

function result(overrides: Partial<FusionRunResult> = {}): FusionRunResult {
  return {
    runId: "fusion-run-1",
    answer: "The answer is 42.",
    model: "anthropic/claude-opus-4.8",
    panel: [
      { model: "A", answer: "a" },
      { model: "B", error: { message: "boom" } },
    ],
    analysis: {
      consensus: ["both agree"],
      contradictions: [{ topic: "scaling", stances: [{ model: "A", stance: "vertical" }] }],
      partialCoverage: [],
      uniqueInsights: [{ model: "A", insight: "use WAL" }],
      blindSpots: ["licensing"],
      ranking: ["A", "B"],
    },
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    costUsd: 0.1234,
    durationMs: 12000,
    web: "used",
    maxToolCallsEnforced: false,
    created: 1730000000,
    ...overrides,
  };
}

test("renderJson emits the OpenAI-compatible chat.completion shape", () => {
  const parsed = JSON.parse(renderJson(result()));
  assert.equal(parsed.object, "chat.completion");
  assert.equal(parsed.choices[0].message.content, "The answer is 42.");
  assert.equal(parsed.fusion.cost_usd, 0.1234);
  assert.equal(parsed.fusion.web, "used");
});

test("renderMarkdown leads with the answer and includes a footer", () => {
  const md = renderMarkdown(result(), { showAnalysis: false });
  assert.match(md, /The answer is 42\./);
  assert.match(md, /cost: \$0\.1234/);
  assert.match(md, /web: used/);
  assert.match(md, /A, B \(failed\)/); // panel summary with failure marked
  assert.doesNotMatch(md, /Judge analysis/);
});

test("renderMarkdown includes analysis when requested", () => {
  const md = renderMarkdown(result(), { showAnalysis: true });
  assert.match(md, /Judge analysis/);
  assert.match(md, /both agree/);
  assert.match(md, /licensing/);
  assert.match(md, /use WAL/);
});

test("renderText includes the answer and footer without markdown headers", () => {
  const txt = renderText(result(), { showAnalysis: false });
  assert.match(txt, /The answer is 42\./);
  assert.match(txt, /cost: \$0\.1234/);
  assert.doesNotMatch(txt, /^#/m);
});

test("cost null renders as n/a; bypass result shows single-model footer", () => {
  const md = renderMarkdown(result({ costUsd: null, panel: undefined, analysis: undefined, web: "off" }), {
    showAnalysis: true,
  });
  assert.match(md, /cost: n\/a/);
  assert.match(md, /single model/);
  assert.doesNotMatch(md, /Judge analysis/); // no analysis in bypass even if requested
});
