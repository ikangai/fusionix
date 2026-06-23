import test from "node:test";
import assert from "node:assert/strict";
import { runDebate } from "../src/pipeline/debate.ts";
import type { ChatGateway, ChatRequest } from "../src/gateway/contract.ts";
import type { ExecutionPlan, GatewayCallResult, PanelResponse } from "../src/types.ts";

function plan(): ExecutionPlan {
  return { runId: "r", panel: ["A", "B", "C"], judge: "J", writer: "W", web: false, bypass: false, maxToolCalls: 8, messages: [] };
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

const revised = (model: string) => ({ content: JSON.stringify({ answer: `rev-${model}` }) });

test("fewer than two survivors → no debate round, responses unchanged, no calls", async () => {
  const responses: PanelResponse[] = [{ model: "A", answer: "a1" }, { model: "B", error: { message: "down" } }];
  const { gateway, calls } = gw(() => revised("X"));
  const out = await runDebate(plan(), "q", responses, { gateway });
  assert.deepEqual(out.responses, responses);
  assert.equal(out.calls.length, 0);
  assert.equal(calls.length, 0);
});

test("revises each surviving panelist; revised answers replace round-1 (§22.5)", async () => {
  const responses: PanelResponse[] = [{ model: "A", answer: "a1" }, { model: "B", answer: "b1" }];
  const { gateway, calls } = gw((req) => revised(req.model));
  const out = await runDebate(plan(), "q", responses, { gateway });
  assert.equal(out.responses[0]?.answer, "rev-A");
  assert.equal(out.responses[1]?.answer, "rev-B");
  assert.equal(out.calls.length, 2);
  assert.equal(calls.length, 2);
  // The debate prompt carries the peer answers block.
  assert.match(typeof calls[0]!.messages[1]?.content === "string" ? calls[0]!.messages[1]!.content as string : "", /a1/);
});

test("a revision that throws keeps that member's round-1 answer", async () => {
  const responses: PanelResponse[] = [{ model: "A", answer: "a1" }, { model: "B", answer: "b1" }];
  const { gateway } = gw((req) => {
    if (req.model === "B") throw new Error("B revision failed");
    return revised(req.model);
  });
  const out = await runDebate(plan(), "q", responses, { gateway });
  assert.equal(out.responses[0]?.answer, "rev-A");
  assert.equal(out.responses[1]?.answer, "b1", "failed revision keeps round-1");
  assert.equal(out.calls.length, 1, "only the successful revision counts for cost");
});

test("an empty revision keeps the round-1 answer (never loses a survivor)", async () => {
  const responses: PanelResponse[] = [{ model: "A", answer: "a1" }, { model: "B", answer: "b1" }];
  const { gateway } = gw((req) => (req.model === "B" ? { content: "  " } : revised(req.model)));
  const out = await runDebate(plan(), "q", responses, { gateway });
  assert.equal(out.responses[0]?.answer, "rev-A");
  assert.equal(out.responses[1]?.answer, "b1", "empty revision keeps round-1");
});

test("a panel that repeats a model id keeps each position's distinct revision (no collapse)", async () => {
  // Duplicate model ids are a legal panel config; positional mapping must not collapse them.
  const responses: PanelResponse[] = [{ model: "A", answer: "a1" }, { model: "A", answer: "a2" }];
  let n = 0;
  const { gateway, calls } = gw(() => ({ content: JSON.stringify({ answer: `rev-A-${(n += 1)}` }) }));
  const out = await runDebate(plan(), "q", responses, { gateway });
  assert.equal(calls.length, 2, "one revision call per survivor position");
  assert.equal(out.responses.length, 2);
  assert.notEqual(out.responses[0]?.answer, out.responses[1]?.answer, "the two positions keep distinct revisions");
});

test("failed panel members stay in place and order is preserved", async () => {
  const responses: PanelResponse[] = [
    { model: "A", answer: "a1" },
    { model: "B", error: { message: "down" } },
    { model: "C", answer: "c1" },
  ];
  const { gateway } = gw((req) => revised(req.model));
  const out = await runDebate(plan(), "q", responses, { gateway });
  assert.deepEqual(out.responses.map((r) => r.model), ["A", "B", "C"]);
  assert.equal(out.responses[0]?.answer, "rev-A");
  assert.ok(out.responses[1]?.error, "failed member untouched");
  assert.equal(out.responses[2]?.answer, "rev-C");
});
