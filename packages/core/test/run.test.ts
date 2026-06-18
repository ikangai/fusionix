import test from "node:test";
import assert from "node:assert/strict";
import { runFusion } from "../src/pipeline/run.ts";
import { isFusionError } from "../src/errors.ts";
import type { ChatGateway, ChatRequest, ChatCallOptions } from "../src/gateway/openrouter.ts";
import type { FusionConfig, FusionStage, GatewayCallResult } from "../src/types.ts";

const VALID_ANALYSIS = JSON.stringify({
  consensus: ["shared"],
  contradictions: [],
  partial_coverage: [],
  unique_insights: [],
  blind_spots: [],
  ranking: ["A", "B", "C"],
});

function makeConfig(panel = ["A", "B", "C"]): FusionConfig {
  return {
    gateway: "https://gw/api/v1",
    defaultPreset: "p",
    defaults: { maxToolCalls: 8, web: true },
    presets: {
      p: { name: "p", description: "", panel, judge: "J", writer: "W", web: true, temperature: 0.5 },
    },
  };
}

type Responder = (req: ChatRequest, opts?: ChatCallOptions) => GatewayCallResult | Promise<GatewayCallResult>;

function makeGateway(responder: Responder) {
  const calls: ChatRequest[] = [];
  const gateway: ChatGateway = {
    async chat(req, opts) {
      calls.push(req);
      return responder(req, opts);
    },
  };
  return { gateway, calls };
}

function usage(p: number, c: number, cost?: number): GatewayCallResult["usage"] {
  const u: GatewayCallResult["usage"] = { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
  if (cost !== undefined) u.cost = cost;
  return u;
}

const userReq = { model: "fusion", messages: [{ role: "user" as const, content: "What is X?" }] };

test("happy path: panel → judge → writer with cost, order, usage, web", async () => {
  const { gateway } = makeGateway((req) => {
    if (req.model.startsWith("J")) return { content: VALID_ANALYSIS, usage: usage(20, 10, 0.25) };
    if (req.model.startsWith("W")) return { content: "FINAL ANSWER", usage: usage(30, 15, 0.125) };
    return { content: JSON.stringify({ answer: `ans-${req.model.replace(":online", "")}` }), usage: usage(10, 5, 0.5) };
  });
  const result = await runFusion(userReq, { config: makeConfig(), gateway, apiKey: "x", runId: "fusion-run-x" });

  assert.equal(result.answer, "FINAL ANSWER");
  assert.equal(result.model, "W");
  assert.deepEqual(result.panel?.map((p) => p.model), ["A", "B", "C"]);
  assert.equal(result.panel?.[0]?.answer, "ans-A");
  assert.deepEqual(result.analysis?.consensus, ["shared"]);
  assert.equal(Math.abs((result.costUsd ?? 0) - 1.875) < 1e-9, true); // 0.5*3 + 0.25 + 0.125
  assert.deepEqual(result.usage, { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 });
  assert.equal(result.web, "used");
  assert.equal(result.maxToolCallsEnforced, false);
  assert.equal(result.runId, "fusion-run-x");
  assert.equal(typeof result.durationMs, "number");
  assert.equal(typeof result.created, "number");
});

test("one panel failure still yields a synthesized answer", async () => {
  const { gateway } = makeGateway((req) => {
    if (req.model.startsWith("B")) throw new Error("panel B down");
    if (req.model.startsWith("J")) return { content: VALID_ANALYSIS };
    if (req.model.startsWith("W")) return { content: "FINAL" };
    return { content: JSON.stringify({ answer: "ok" }) };
  });
  const result = await runFusion(userReq, { config: makeConfig(), gateway, apiKey: "x" });
  assert.equal(result.answer, "FINAL");
  assert.equal(result.panel?.[1]?.model, "B");
  assert.ok(result.panel?.[1]?.error, "failed member kept in place");
  assert.equal(result.panel?.[0]?.answer, "ok");
});

test("all panel models failing → all_panel_failed", async () => {
  const { gateway } = makeGateway((req) => {
    if (req.model.startsWith("J") || req.model.startsWith("W")) return { content: "should not be called" };
    throw new Error("panel down");
  });
  await assert.rejects(
    () => runFusion(userReq, { config: makeConfig(), gateway, apiKey: "x" }),
    (err: unknown) => isFusionError(err) && err.code === "all_panel_failed" && err.httpStatus === 502,
  );
});

test("progress callbacks fire in stage order", async () => {
  const stages: FusionStage[] = [];
  const { gateway } = makeGateway((req) => {
    if (req.model.startsWith("J")) return { content: VALID_ANALYSIS };
    if (req.model.startsWith("W")) return { content: "FINAL" };
    return { content: JSON.stringify({ answer: "ok" }) };
  });
  await runFusion(userReq, { config: makeConfig(), gateway, apiKey: "x", onProgress: (s) => stages.push(s) });
  assert.deepEqual(stages, ["panel", "judge", "writer"]);
});

test("single-model bypass (enabled:false): answer only, no panel/analysis, web off", async () => {
  const { gateway, calls } = makeGateway(() => ({ content: "SINGLE", usage: usage(5, 5, 0.5) }));
  const result = await runFusion(
    { model: "openai/gpt-z", plugins: [{ id: "fusion", enabled: false }], messages: userReq.messages },
    { config: makeConfig(), gateway, apiKey: "x", webOverride: false },
  );
  assert.equal(result.answer, "SINGLE");
  assert.equal(result.panel, undefined);
  assert.equal(result.analysis, undefined);
  assert.equal(result.web, "off");
  assert.equal(result.costUsd, 0.5);
  assert.equal(calls.length, 1, "exactly one model call in bypass");
  assert.equal(calls[0]!.model, "openai/gpt-z");
});

test("invalid request is rejected before any gateway call", async () => {
  const { gateway, calls } = makeGateway(() => ({ content: "x" }));
  await assert.rejects(
    () => runFusion({ model: "openai/x", messages: userReq.messages }, { config: makeConfig(), gateway, apiKey: "x" }),
    (err: unknown) => isFusionError(err) && err.code === "not_a_fusion_request",
  );
  assert.equal(calls.length, 0);
});

test("web off when the plan disables web", async () => {
  const { gateway, calls } = makeGateway((req) => {
    if (req.model.startsWith("J")) return { content: VALID_ANALYSIS };
    if (req.model.startsWith("W")) return { content: "FINAL" };
    return { content: JSON.stringify({ answer: "ok" }) };
  });
  const result = await runFusion(userReq, { config: makeConfig(), gateway, apiKey: "x", webOverride: false });
  assert.equal(result.web, "off");
  // panel calls must NOT carry :online
  assert.ok(calls.filter((c) => c.model.includes(":online")).length === 0);
});

test("timeout with ≥1 survivor proceeds to judge; final answer returned", async () => {
  const { gateway } = makeGateway((req, opts) => {
    if (req.model.startsWith("SLOW")) {
      return new Promise<GatewayCallResult>((_resolve, reject) => {
        if (opts?.signal?.aborted) return reject(new Error("aborted"));
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (req.model.startsWith("J")) return Promise.resolve({ content: VALID_ANALYSIS });
    if (req.model.startsWith("W")) return Promise.resolve({ content: "FINAL" });
    return Promise.resolve({ content: JSON.stringify({ answer: "fast" }) });
  });
  const result = await runFusion(userReq, {
    config: makeConfig(["FAST", "SLOW"]),
    gateway,
    apiKey: "x",
    maxRequestDurationMs: 30,
  });
  assert.equal(result.answer, "FINAL");
  assert.equal(result.panel?.[0]?.answer, "fast");
  assert.ok(result.panel?.[1]?.error, "slow member aborted at deadline");
});

test("onWriterDelta streams the final answer when the gateway supports it", async () => {
  const gateway: ChatGateway = {
    async chat(req) {
      if (req.model.startsWith("J")) return { content: VALID_ANALYSIS };
      return { content: JSON.stringify({ answer: "ok" }) }; // panel
    },
    async *streamChat() {
      yield "Fin";
      yield "al";
      return { content: "Final" };
    },
  };
  const deltas: string[] = [];
  const result = await runFusion(userReq, {
    config: makeConfig(),
    gateway,
    apiKey: "x",
    onWriterDelta: (d) => deltas.push(d),
  });
  assert.deepEqual(deltas, ["Fin", "al"]);
  assert.equal(result.answer, "Final");
});

test("timeout with zero survivors → all_panel_failed", async () => {
  const { gateway } = makeGateway((req, opts) => {
    if (req.model.startsWith("SLOW")) {
      return new Promise<GatewayCallResult>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return Promise.resolve({ content: "unused" });
  });
  await assert.rejects(
    () =>
      runFusion(userReq, {
        config: makeConfig(["SLOW1", "SLOW2"]),
        gateway,
        apiKey: "x",
        maxRequestDurationMs: 30,
      }),
    (err: unknown) => isFusionError(err) && err.code === "all_panel_failed",
  );
});
