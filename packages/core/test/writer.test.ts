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

test("streams writer deltas via onDelta when streamChat is available", async () => {
  let streamCalled = false;
  let chatCalled = false;
  const gateway: ChatGateway = {
    async chat() {
      chatCalled = true;
      return { content: "non-stream" };
    },
    async *streamChat() {
      streamCalled = true;
      yield "Fin";
      yield "al";
      return { content: "Final", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.01 } };
    },
  };
  const deltas: string[] = [];
  const { answer, call } = await runWriter(makePlan(), "q", analysis, { gateway, onDelta: (d) => deltas.push(d) });
  assert.equal(streamCalled, true);
  assert.equal(chatCalled, false);
  assert.deepEqual(deltas, ["Fin", "al"]);
  assert.equal(answer, "Final");
  assert.equal(call.usage?.cost, 0.01);
});

test("falls back to non-streaming chat when onDelta is not provided", async () => {
  let chatCalled = false;
  const gateway: ChatGateway = {
    async chat() {
      chatCalled = true;
      return { content: "non-stream" };
    },
    async *streamChat() {
      yield "x";
      return { content: "x" };
    },
  };
  const { answer } = await runWriter(makePlan(), "q", analysis, { gateway });
  assert.equal(chatCalled, true);
  assert.equal(answer, "non-stream");
});
