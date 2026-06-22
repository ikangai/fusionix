import test from "node:test";
import assert from "node:assert/strict";
import { runPanel } from "../src/pipeline/panel.ts";
import { PANEL_SYSTEM } from "../src/prompts.ts";
import { FusionixError } from "../src/errors.ts";
import type { ChatGateway, ChatRequest, ChatCallOptions } from "../src/gateway/contract.ts";
import type { ExecutionPlan, GatewayCallResult } from "../src/types.ts";

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
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

type Responder = (model: string) => GatewayCallResult;

function fakeGateway(responder: Responder) {
  const calls: { req: ChatRequest; opts?: ChatCallOptions }[] = [];
  const gateway: ChatGateway = {
    async chat(req, opts) {
      calls.push({ req, opts });
      return responder(req.model);
    },
  };
  return { gateway, calls };
}

test("runs all panel models in resolved order and parses JSON answers", async () => {
  const responder: Responder = (model) => ({
    content: JSON.stringify({ answer: `ans-${model}`, assumptions: [`asm-${model}`], risks: [], citations: [{ url: "https://x" }] }),
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.1 },
  });
  const { gateway } = fakeGateway(responder);
  const { responses, calls } = await runPanel(makePlan({ panelTemperature: 0.5 }), { gateway });

  assert.equal(responses.length, 3);
  assert.deepEqual(responses.map((r) => r.model), ["A", "B", "C"]);
  assert.equal(responses[0]!.answer, "ans-A");
  assert.deepEqual(responses[0]!.assumptions, ["asm-A"]);
  assert.deepEqual(responses[0]!.citations, [{ url: "https://x" }]);
  assert.equal(calls.length, 3, "all successful calls returned for cost");
});

test("a failed panel member stays in position as {model, error}", async () => {
  const responder: Responder = (model) => {
    if (model === "B") throw new FusionixError("gateway_error", "boom");
    return { content: JSON.stringify({ answer: `a-${model}` }) };
  };
  const { gateway } = fakeGateway(responder);
  const { responses, calls } = await runPanel(makePlan(), { gateway });

  assert.equal(responses.length, 3);
  assert.equal(responses[0]!.answer, "a-A");
  assert.deepEqual(responses[1], { model: "B", error: { message: "boom" } });
  assert.equal(responses[1]!.answer, undefined);
  assert.equal(responses[2]!.answer, "a-C");
  assert.equal(calls.length, 2, "only successful calls counted for cost");
});

test("non-JSON panel output keeps the raw text as the answer (no repair, §14.1)", async () => {
  const { gateway } = fakeGateway(() => ({ content: "just prose, no json here" }));
  const { responses } = await runPanel(makePlan({ panel: ["A"] }), { gateway });
  assert.equal(responses[0]!.answer, "just prose, no json here");
  assert.equal(responses[0]!.assumptions, undefined);
});

test("web enables :online on the call but the response keeps the base slug", async () => {
  const { gateway, calls } = fakeGateway((model) => ({ content: JSON.stringify({ answer: model }) }));
  const { responses } = await runPanel(makePlan({ panel: ["A"], web: true }), { gateway });
  assert.equal(calls[0]!.req.model, "A:online");
  assert.equal(responses[0]!.model, "A");
});

test("panel messages = panel instruction (+preset system) then preserved caller messages", async () => {
  const { gateway, calls } = fakeGateway(() => ({ content: "{}" }));
  const plan = makePlan({
    panel: ["A"],
    panelSystem: "DOMAIN-PROMPT",
    messages: [
      { role: "system", content: "caller-sys" },
      { role: "user", content: "q" },
    ],
  });
  await runPanel(plan, { gateway });
  const msgs = calls[0]!.req.messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0]!.role, "system");
  assert.match(String(msgs[0]!.content), /independently/); // PANEL_SYSTEM text
  assert.match(String(msgs[0]!.content), /DOMAIN-PROMPT/);
  assert.equal(msgs[1]!.content, "caller-sys");
  assert.equal(msgs[2]!.role, "user");
  assert.ok(PANEL_SYSTEM.length > 0);
});

test("panel temperature and maxTokens are passed through", async () => {
  const { gateway, calls } = fakeGateway(() => ({ content: "{}" }));
  await runPanel(makePlan({ panel: ["A"], panelTemperature: 0.3, panelMaxTokens: 999 }), { gateway });
  assert.equal(calls[0]!.req.temperature, 0.3);
  assert.equal(calls[0]!.req.maxTokens, 999);
});

test("an empty-content response is treated as a member failure (cost still counted)", async () => {
  const { gateway } = fakeGateway(() => ({
    content: "   ",
    usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, cost: 0.01 },
  }));
  const { responses, calls } = await runPanel(makePlan({ panel: ["A"] }), { gateway });
  assert.ok(responses[0]!.error, "empty response marked as failure");
  assert.equal(responses[0]!.answer, undefined);
  assert.equal(calls.length, 1, "the call still counts toward cost");
});

test("webUsed is true when the :online variant serves a member", async () => {
  const { gateway } = fakeGateway(() => ({ content: JSON.stringify({ answer: "ok" }) }));
  const out = await runPanel(makePlan({ panel: ["A"], web: true }), { gateway });
  assert.equal(out.webUsed, true);
});

test("webUsed is false when a member falls back from :online (§15)", async () => {
  const { gateway } = fakeGateway((model) => {
    if (model.endsWith(":online")) throw new Error("no web");
    return { content: JSON.stringify({ answer: "ok" }) };
  });
  const out = await runPanel(makePlan({ panel: ["A"], web: true }), { gateway });
  assert.equal(out.responses[0]!.answer, "ok"); // succeeded via fallback
  assert.equal(out.webUsed, false);
});

test("the abort signal is forwarded to each call", async () => {
  const { gateway, calls } = fakeGateway(() => ({ content: "{}" }));
  const ac = new AbortController();
  await runPanel(makePlan({ panel: ["A"] }), { gateway, signal: ac.signal });
  assert.equal(calls[0]!.opts?.signal, ac.signal);
});
