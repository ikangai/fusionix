import test from "node:test";
import assert from "node:assert/strict";
import { runJudge } from "../src/pipeline/judge.ts";
import { isFusionixError } from "../src/errors.ts";
import type { ChatGateway, ChatRequest, ChatCallOptions } from "../src/gateway/contract.ts";
import type { ExecutionPlan, GatewayCallResult, PanelResponse } from "../src/types.ts";

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

const panel: PanelResponse[] = [
  { model: "A", answer: "ans A" },
  { model: "B", answer: "ans B" },
];

type Handler = (req: ChatRequest) => GatewayCallResult;

function sequencedGateway(handlers: Handler[]) {
  const calls: { req: ChatRequest; opts?: ChatCallOptions }[] = [];
  let i = 0;
  const gateway: ChatGateway = {
    async chat(req, opts) {
      calls.push({ req, opts });
      const h = handlers[Math.min(i, handlers.length - 1)]!;
      i += 1;
      return h(req);
    },
  };
  return { gateway, calls };
}

const VALID = JSON.stringify({
  consensus: ["c1"],
  contradictions: [{ topic: "t", stances: [{ model: "A", stance: "yes" }] }],
  partial_coverage: [{ models: ["A"], point: "p" }],
  unique_insights: [{ model: "B", insight: "i" }],
  blind_spots: ["b"],
  ranking: ["A", "B"],
});

test("parses valid judge JSON (snake_case → camelCase) in one call", async () => {
  const { gateway, calls } = sequencedGateway([() => ({ content: VALID })]);
  const { analysis, calls: out } = await runJudge(makePlan(), "What is X?", panel, { gateway });
  assert.deepEqual(analysis.consensus, ["c1"]);
  assert.equal(analysis.contradictions[0]!.topic, "t");
  assert.equal(analysis.contradictions[0]!.stances[0]!.model, "A");
  assert.equal(analysis.partialCoverage[0]!.point, "p");
  assert.equal(analysis.uniqueInsights[0]!.insight, "i");
  assert.deepEqual(analysis.blindSpots, ["b"]);
  assert.deepEqual(analysis.ranking, ["A", "B"]);
  assert.equal(calls.length, 1);
  assert.equal(out.length, 1);
});

test("coerces missing keys to empty arrays without repair", async () => {
  const { gateway, calls } = sequencedGateway([() => ({ content: '{"consensus":["only"]}' })]);
  const { analysis } = await runJudge(makePlan(), "q", panel, { gateway });
  assert.deepEqual(analysis.consensus, ["only"]);
  assert.deepEqual(analysis.contradictions, []);
  assert.deepEqual(analysis.partialCoverage, []);
  assert.deepEqual(analysis.uniqueInsights, []);
  assert.deepEqual(analysis.blindSpots, []);
  assert.deepEqual(analysis.ranking, []);
  assert.equal(calls.length, 1, "no repair for a present-but-partial object");
});

test("repairs once when the first output is not JSON", async () => {
  const { gateway, calls } = sequencedGateway([
    () => ({ content: "Here is my comparison in prose, no JSON." }),
    () => ({ content: VALID }),
  ]);
  const { analysis, calls: out } = await runJudge(makePlan(), "q", panel, { gateway });
  assert.deepEqual(analysis.consensus, ["c1"]);
  assert.equal(calls.length, 2, "one initial + one repair call");
  assert.equal(out.length, 2, "both calls counted for cost");
  assert.equal(calls[1]!.req.model, "J", "repair uses the same judge model");
});

test("repairs when the first output parses as a non-object (JSON array)", async () => {
  const { gateway, calls } = sequencedGateway([() => ({ content: "[1, 2, 3]" }), () => ({ content: VALID })]);
  const { analysis } = await runJudge(makePlan(), "q", panel, { gateway });
  assert.deepEqual(analysis.consensus, ["c1"]);
  assert.equal(calls.length, 2, "array is not an object → one repair");
});

test("throws judge_failed when JSON is missing after one repair", async () => {
  const { gateway, calls } = sequencedGateway([() => ({ content: "no json ever" })]);
  await assert.rejects(
    () => runJudge(makePlan(), "q", panel, { gateway }),
    (err: unknown) => isFusionixError(err) && err.code === "judge_failed" && err.httpStatus === 502,
  );
  assert.equal(calls.length, 2, "attempted initial + one repair");
});

test("judge never uses web even when the plan enables it", async () => {
  const { gateway, calls } = sequencedGateway([() => ({ content: VALID })]);
  await runJudge(makePlan({ web: true }), "q", panel, { gateway });
  assert.equal(calls[0]!.req.model, "J");
});

test("a thrown first judge call → judge_failed with no repair", async () => {
  const { gateway, calls } = sequencedGateway([
    () => {
      throw new Error("network down");
    },
  ]);
  await assert.rejects(
    () => runJudge(makePlan(), "q", panel, { gateway }),
    (err: unknown) => isFusionixError(err) && err.code === "judge_failed",
  );
  assert.equal(calls.length, 1, "no repair attempted when the call itself fails");
});

test("judge temperature and maxTokens are passed through", async () => {
  const { gateway, calls } = sequencedGateway([() => ({ content: VALID })]);
  await runJudge(makePlan({ judgeTemperature: 0.2, judgeMaxTokens: 1000 }), "q", panel, { gateway });
  assert.equal(calls[0]!.req.temperature, 0.2);
  assert.equal(calls[0]!.req.maxTokens, 1000);
});
