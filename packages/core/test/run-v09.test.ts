import test from "node:test";
import assert from "node:assert/strict";
import { runFusionix } from "../src/pipeline/run.ts";
import type { ChatGateway, ChatRequest } from "../src/gateway/contract.ts";
import type { FusionixConfig, GatewayCallResult } from "../src/types.ts";

// v0.9 §22.2 adaptive aggregator + §22.4 routing, end-to-end through runFusionix.

const OPUS = "anthropic/claude-opus-4.8";
const GPT = "openai/gpt-5.2";
const GEMINI = "google/gemini-3.1-pro-preview";

function config(): FusionixConfig {
  return {
    gateway: "https://gw/api/v1",
    defaultPreset: "p",
    defaults: { maxToolCalls: 8, web: true },
    presets: {
      p: { name: "p", description: "", panel: [OPUS, GPT, GEMINI], judge: GPT, writer: GPT, web: false, temperature: 0.5 },
    },
  };
}

// Detect stage by the system prompt so judge and writer may share a model slug.
function stageOf(req: ChatRequest): "panel" | "debate" | "judge" | "writer" | "single" {
  const sys = req.messages.find((m) => m.role === "system");
  const s = typeof sys?.content === "string" ? sys.content : "";
  if (s.startsWith("You are one expert in a panel")) return "panel";
  if (s.startsWith("You are revising your earlier answer")) return "debate";
  if (s.startsWith("You compare several model answers")) return "judge";
  if (s.startsWith("Write the final answer")) return "writer";
  return "single";
}

function gatewayWith(ranking: string[]) {
  const calls: ChatRequest[] = [];
  const analysis = JSON.stringify({
    consensus: ["x"], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [], ranking,
  });
  const gateway: ChatGateway = {
    async chat(req) {
      calls.push(req);
      const u: GatewayCallResult["usage"] = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.1 };
      const stage = stageOf(req);
      if (stage === "panel") return { content: JSON.stringify({ answer: `ans-${req.model}` }), usage: u };
      if (stage === "debate") return { content: JSON.stringify({ answer: `rev-${req.model}` }), usage: u };
      if (stage === "judge") return { content: analysis, usage: u };
      return { content: "FINAL", usage: u }; // writer / single
    },
  };
  return { gateway, calls };
}

const fx = (plugin: Record<string, unknown>, content = "What is X?") => ({
  model: "fusionix",
  messages: [{ role: "user" as const, content }],
  plugins: [{ id: "fusionix" as const, ...plugin }],
});

function writerModelOf(calls: ChatRequest[]): string | undefined {
  return calls.find((c) => stageOf(c) === "writer")?.model;
}

function judgeSystemOf(calls: ChatRequest[]): string {
  const j = calls.find((c) => stageOf(c) === "judge");
  const sys = j?.messages.find((m) => m.role === "system");
  return typeof sys?.content === "string" ? sys.content : "";
}

test("top-ranked adds the model-id ranking instruction to the judge prompt; default does not (§22.2)", async () => {
  const a = gatewayWith([GEMINI]);
  await runFusionix(fx({ writer_strategy: "top-ranked" }), { config: config(), gateway: a.gateway, apiKey: "x" });
  assert.match(judgeSystemOf(a.calls), /model-id/, "top-ranked judge prompt is augmented");

  const b = gatewayWith([GEMINI]);
  await runFusionix(fx({}), { config: config(), gateway: b.gateway, apiKey: "x" });
  assert.doesNotMatch(judgeSystemOf(b.calls), /model-id/, "default judge prompt is the pristine §14.2 text");
});

test("writer-strategy 'fixed' (default) uses the configured writer despite the ranking", async () => {
  const { gateway, calls } = gatewayWith([GEMINI, OPUS, GPT]);
  const r = await runFusionix(fx({}), { config: config(), gateway, apiKey: "x" });
  assert.equal(r.model, GPT);
  assert.equal(writerModelOf(calls), GPT);
});

test("writer-strategy 'top-ranked' routes the writer call to the judge's #1 model (§22.2)", async () => {
  const { gateway, calls } = gatewayWith([GEMINI, OPUS, GPT]);
  const r = await runFusionix(fx({ writer_strategy: "top-ranked" }), { config: config(), gateway, apiKey: "x" });
  assert.equal(r.model, GEMINI, "result reports the adaptively-chosen writer");
  assert.equal(writerModelOf(calls), GEMINI, "the writer call actually went to Gemini");
  // Panel/judge/analysis still present (deliberation unaffected).
  assert.equal(r.panel?.length, 3);
  assert.ok(r.analysis);
});

test("writer-strategy 'capability' picks the math specialist for a math prompt (§22.2)", async () => {
  const { gateway, calls } = gatewayWith([OPUS]);
  const r = await runFusionix(fx({ writer_strategy: "capability" }, "Prove the theorem about polynomial roots"), {
    config: config(),
    gateway,
    apiKey: "x",
  });
  assert.equal(r.model, GPT);
  assert.equal(writerModelOf(calls), GPT);
});

test("routing end-to-end: math prompt → single Gpt call, routeCategory flows into the result (§22.4)", async () => {
  const { gateway, calls } = gatewayWith([]);
  const r = await runFusionix(fx({ route: true }, "Prove the theorem about polynomial roots"), {
    config: config(),
    gateway,
    apiKey: "x",
  });
  assert.equal(r.model, GPT, "routed to the math specialist");
  assert.equal(r.routeCategory, "math");
  assert.equal(r.panel, undefined, "routing runs as a single-model call");
  assert.equal(r.analysis, undefined);
  // Exactly one gateway call (no panel/judge), and it was the single-model writer.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, GPT);
});

test("topology 'debate' inserts a revision round; revised answers reach the judge and result (§22.5)", async () => {
  const stages: string[] = [];
  const { gateway, calls } = gatewayWith([]);
  const r = await runFusionix(fx({ topology: "debate" }), {
    config: config(),
    gateway,
    apiKey: "x",
    onProgress: (s) => stages.push(s),
  });
  // The result panel carries the REVISED answers, not the round-1 answers.
  assert.deepEqual(r.panel?.map((p) => p.answer), [`rev-${OPUS}`, `rev-${GPT}`, `rev-${GEMINI}`]);
  // Debate is a distinct stage between panel and judge.
  assert.deepEqual(stages, ["panel", "debate", "judge", "writer"]);
  // 3 panel + 3 debate + 1 judge + 1 writer = 8 gateway calls.
  assert.equal(calls.length, 8);
});

test("topology 'standard' (default) runs no debate round", async () => {
  const stages: string[] = [];
  const { gateway } = gatewayWith([]);
  const r = await runFusionix(fx({}), { config: config(), gateway, apiKey: "x", onProgress: (s) => stages.push(s) });
  assert.deepEqual(r.panel?.map((p) => p.answer), [`ans-${OPUS}`, `ans-${GPT}`, `ans-${GEMINI}`]);
  assert.deepEqual(stages, ["panel", "judge", "writer"]);
});

test("accept-on-consensus skips the writer and returns the top panelist (§23.1)", async () => {
  const stages: string[] = [];
  const { gateway, calls } = gatewayWith([GPT, OPUS, GEMINI]); // judge agrees, ranks GPT first
  const r = await runFusionix(fx({ accept_on_consensus: true }), {
    config: config(),
    gateway,
    apiKey: "x",
    onProgress: (s) => stages.push(s),
  });
  assert.equal(r.acceptedOnConsensus, true);
  assert.equal(r.model, GPT, "accepted the judge's #1 panelist");
  assert.equal(r.answer, `ans-${GPT}`, "answer is the panelist's, not a writer synthesis");
  assert.ok(r.analysis, "analysis is still present");
  assert.equal(calls.filter((c) => stageOf(c) === "writer").length, 0, "no writer call");
  assert.deepEqual(stages, ["panel", "judge"], "writer stage never announced");
});

test("accept-on-consensus does NOT skip the writer when the judge reports a contradiction (§23.1)", async () => {
  const calls: ChatRequest[] = [];
  const withContradiction = JSON.stringify({
    consensus: [], contradictions: [{ topic: "approach", stances: [] }],
    partial_coverage: [], unique_insights: [], blind_spots: [], ranking: [GPT],
  });
  const gateway: ChatGateway = {
    async chat(req) {
      calls.push(req);
      const u: GatewayCallResult["usage"] = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.1 };
      const stage = stageOf(req);
      if (stage === "panel") return { content: JSON.stringify({ answer: `ans-${req.model}` }), usage: u };
      if (stage === "judge") return { content: withContradiction, usage: u };
      return { content: "FINAL", usage: u };
    },
  };
  const r = await runFusionix(fx({ accept_on_consensus: true }), { config: config(), gateway, apiKey: "x" });
  assert.notEqual(r.acceptedOnConsensus, true, "gate did not fire");
  assert.equal(r.answer, "FINAL", "the writer ran");
  assert.equal(calls.filter((c) => stageOf(c) === "writer").length, 1, "writer was called");
});
