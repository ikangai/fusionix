import test from "node:test";
import assert from "node:assert/strict";
import { aggregateUsage } from "../src/cost.ts";
import type { GatewayCallResult } from "../src/types.ts";

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
