import test from "node:test";
import assert from "node:assert/strict";
import { runChain } from "../src/pipeline/chain.ts";
import { isFusionixError } from "../src/errors.ts";
import type { ChatGateway, ChatRequest } from "../src/gateway/contract.ts";
import type { ExecutionPlan, GatewayCallResult } from "../src/types.ts";

function plan(panel: string[]): ExecutionPlan {
  return {
    runId: "r", panel, judge: "", writer: "W", web: false, bypass: false, maxToolCalls: 8,
    topology: "chain", messages: [{ role: "user", content: "Q" }],
  };
}
function gw(handler: (req: ChatRequest) => GatewayCallResult) {
  const calls: ChatRequest[] = [];
  const gateway: ChatGateway = {
    async chat(req) {
      calls.push(req);
      return handler(req);
    },
  };
  return { gateway, calls };
}
const usage: GatewayCallResult["usage"] = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.1 };
const deps = (gateway: ChatGateway) => ({ gateway, signal: new AbortController().signal });
const now = () => 1000;
const userOf = (req: ChatRequest): string => {
  const m = req.messages.find((x) => x.role === "user");
  return typeof m?.content === "string" ? m.content : "";
};

test("chain runs panel models sequentially; the final answer is the last step", async () => {
  const { gateway, calls } = gw((req) => ({ content: JSON.stringify({ answer: `step-${req.model}` }), usage }));
  const r = await runChain(plan(["A", "B", "C"]), deps(gateway), {}, 0, now);
  assert.equal(r.answer, "step-C");
  assert.equal(r.model, "C");
  assert.deepEqual(r.panel?.map((p) => p.answer), ["step-A", "step-B", "step-C"]);
  assert.equal(r.analysis, undefined, "chain has no judge analysis");
  assert.equal(calls.length, 3);
});

test("each step sees the prior steps' work; the first does not", async () => {
  const { gateway, calls } = gw((req) => ({ content: JSON.stringify({ answer: `out-${req.model}` }), usage }));
  await runChain(plan(["A", "B"]), deps(gateway), {}, 0, now);
  assert.doesNotMatch(userOf(calls[0]!), /Work so far/);
  assert.match(userOf(calls[1]!), /Work so far/);
  assert.match(userOf(calls[1]!), /out-A/, "step B sees step A's output");
});

test("a step that fails is kept in place; the chain finalizes on the last good step", async () => {
  const { gateway } = gw((req) => {
    if (req.model === "B") throw new Error("B down");
    return { content: JSON.stringify({ answer: `ok-${req.model}` }), usage };
  });
  const r = await runChain(plan(["A", "B", "C"]), deps(gateway), {}, 0, now);
  assert.equal(r.answer, "ok-C");
  assert.ok(r.panel?.[1]?.error, "B kept as a failed step");
});

test("an empty step is kept as a failure and not used as the answer, but is still billed", async () => {
  const { gateway } = gw((req) => ({ content: req.model === "C" ? "   " : JSON.stringify({ answer: `ok-${req.model}` }), usage }));
  const r = await runChain(plan(["A", "B", "C"]), deps(gateway), {}, 0, now);
  assert.equal(r.answer, "ok-B", "falls back to the last step with content");
  // The empty step's call still consumed tokens — count it for cost (mirrors the panel).
  assert.equal(r.usage.total_tokens, 6, "all three billed calls counted");
  assert.ok(Math.abs((r.costUsd ?? 0) - 0.3) < 1e-9, "all three billed calls' cost counted");
});

test("all steps failing → all_panel_failed", async () => {
  const { gateway } = gw(() => {
    throw new Error("down");
  });
  await assert.rejects(
    () => runChain(plan(["A", "B"]), deps(gateway), {}, 0, now),
    (e: unknown) => isFusionixError(e) && e.code === "all_panel_failed",
  );
});

test("progress fires once per step", async () => {
  const stages: string[] = [];
  const { gateway } = gw(() => ({ content: JSON.stringify({ answer: "x" }), usage }));
  await runChain(plan(["A", "B", "C"]), deps(gateway), { onProgress: (s) => stages.push(s) }, 0, now);
  assert.deepEqual(stages, ["chain", "chain", "chain"]);
});

test("a single-model chain produces the final answer directly", async () => {
  const { gateway, calls } = gw((req) => ({ content: JSON.stringify({ answer: `solo-${req.model}` }), usage }));
  const r = await runChain(plan(["A"]), deps(gateway), {}, 0, now);
  assert.equal(r.answer, "solo-A");
  assert.match(userOf(calls[0]!), /final answer/i);
});
