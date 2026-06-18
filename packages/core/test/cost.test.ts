import test from "node:test";
import assert from "node:assert/strict";
import { aggregateUsage, estimateCost } from "../src/cost.ts";
import type { ExecutionPlan, GatewayCallResult } from "../src/types.ts";

function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    runId: "r",
    panel: ["A", "B", "C"],
    judge: "J",
    writer: "W",
    web: false,
    bypass: false,
    maxToolCalls: 8,
    messages: [{ role: "user", content: "q" }],
    ...overrides,
  };
}

// per-token prices; with promptChars 0 and 1 completion token, each stage costs `completion`.
const prices = { A: { prompt: 0, completion: 0.5 }, B: { prompt: 0, completion: 0.5 }, C: { prompt: 0, completion: 0.5 }, J: { prompt: 0, completion: 0.5 }, W: { prompt: 0, completion: 0.5 } };
const estOpts = { promptChars: 0, completionTokensPerStage: 1 };

function call(prompt: number, completion: number, cost?: number): GatewayCallResult {
  const usage: GatewayCallResult["usage"] = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  if (cost !== undefined) usage.cost = cost;
  return { content: "x", usage };
}

test("sums tokens and cost across calls", () => {
  const { usage, costUsd } = aggregateUsage([call(10, 5, 0.5), call(20, 10, 0.25)]);
  assert.deepEqual(usage, { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 });
  assert.equal(costUsd, 0.75);
});

test("costUsd is null when no call reports a cost (tokens still summed)", () => {
  const { usage, costUsd } = aggregateUsage([call(10, 5), call(20, 10)]);
  assert.deepEqual(usage, { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 });
  assert.equal(costUsd, null);
});

test("partial costs are summed (number, not null)", () => {
  const { costUsd } = aggregateUsage([call(10, 5, 0.5), call(20, 10), call(1, 1, 0.25)]);
  assert.equal(costUsd, 0.75);
});

test("calls without usage are skipped", () => {
  const { usage, costUsd } = aggregateUsage([{ content: "no usage" }, call(5, 5, 0.5)]);
  assert.deepEqual(usage, { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
  assert.equal(costUsd, 0.5);
});

test("empty input → zero usage, null cost", () => {
  const { usage, costUsd } = aggregateUsage([]);
  assert.deepEqual(usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal(costUsd, null);
});

test("estimateCost sums panel + judge + writer when all prices are known", () => {
  const { estimateUsd, missing } = estimateCost(plan(), prices, estOpts);
  assert.equal(estimateUsd, 2.5); // 5 stages × 0.5
  assert.deepEqual(missing, []);
});

test("estimateCost reports missing models and still returns a partial estimate", () => {
  const partial = { A: { prompt: 0, completion: 0.5 }, B: { prompt: 0, completion: 0.5 }, C: { prompt: 0, completion: 0.5 } };
  const { estimateUsd, missing } = estimateCost(plan(), partial, estOpts);
  assert.equal(estimateUsd, 1.5); // only the 3 panel models
  assert.deepEqual(missing.sort(), ["J", "W"]);
});

test("estimateCost returns null estimate when no prices are known", () => {
  const { estimateUsd, missing } = estimateCost(plan(), {}, estOpts);
  assert.equal(estimateUsd, null);
  assert.equal(missing.length, 5);
});

test("estimateCost in bypass counts only the writer", () => {
  const { estimateUsd, missing } = estimateCost(plan({ bypass: true }), prices, estOpts);
  assert.equal(estimateUsd, 0.5);
  assert.deepEqual(missing, []);
});
