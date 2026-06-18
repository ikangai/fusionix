import test from "node:test";
import assert from "node:assert/strict";
import { runWriter } from "../src/pipeline/writer.ts";
import { isFusionError } from "../src/errors.ts";
import type { ChatGateway, ChatRequest, ChatCallOptions } from "../src/gateway/openrouter.ts";
import type { ExecutionPlan, FusionAnalysis, GatewayCallResult } from "../src/types.ts";

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    runId: "r",
    panel: ["A", "B"],
    judge: "J",
    writer: "W",
    web: false,
    bypass: false,
    maxToolCalls: 8,
    messages: [{ role: "user", content: "q" }],
    ...overrides,
  };
}

const analysis: FusionAnalysis = {
  consensus: ["c"],
  contradictions: [],
  partialCoverage: [],
  uniqueInsights: [],
  blindSpots: [],
  ranking: [],
};

function fakeGateway(responder: (req: ChatRequest) => GatewayCallResult) {
  const calls: { req: ChatRequest; opts?: ChatCallOptions }[] = [];
  const gateway: ChatGateway = {
    async chat(req, opts) {
      calls.push({ req, opts });
      return responder(req);
    },
  };
  return { gateway, calls };
}

test("returns the writer content as the final answer", async () => {
  const { gateway } = fakeGateway(() => ({ content: "Final answer.", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  const { answer, call } = await runWriter(makePlan(), "What is X?", analysis, { gateway });
  assert.equal(answer, "Final answer.");
  assert.ok(call.usage, "call returned for cost");
});

test("passes writer temperature and maxTokens", async () => {
  const { gateway, calls } = fakeGateway(() => ({ content: "ok" }));
  await runWriter(makePlan({ writerTemperature: 0.4, writerMaxTokens: 1500 }), "q", analysis, { gateway });
  assert.equal(calls[0]!.req.temperature, 0.4);
  assert.equal(calls[0]!.req.maxTokens, 1500);
});

test("writer never uses web even when the plan enables it", async () => {
  const { gateway, calls } = fakeGateway(() => ({ content: "ok" }));
  await runWriter(makePlan({ web: true }), "q", analysis, { gateway });
  assert.equal(calls[0]!.req.model, "W");
});

test("writer messages = writer instruction (+preset) then prompt + analysis", async () => {
  const { gateway, calls } = fakeGateway(() => ({ content: "ok" }));
  await runWriter(makePlan({ writerSystem: "WX" }), "What is X?", analysis, { gateway });
  const msgs = calls[0]!.req.messages;
  assert.match(String(msgs[0]!.content), /Lead with the answer/);
  assert.match(String(msgs[0]!.content), /WX/);
  assert.match(String(msgs[1]!.content), /What is X\?/);
  assert.match(String(msgs[1]!.content), /consensus/);
});

test("empty writer output → writer_failed", async () => {
  const { gateway } = fakeGateway(() => ({ content: "   " }));
  await assert.rejects(
    () => runWriter(makePlan(), "q", analysis, { gateway }),
    (err: unknown) => isFusionError(err) && err.code === "writer_failed" && err.httpStatus === 502,
  );
});

test("a thrown writer call → writer_failed", async () => {
  const { gateway } = fakeGateway(() => {
    throw new Error("boom");
  });
  await assert.rejects(
    () => runWriter(makePlan(), "q", analysis, { gateway }),
    (err: unknown) => isFusionError(err) && err.code === "writer_failed",
  );
});
