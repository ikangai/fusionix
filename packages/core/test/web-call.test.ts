import test from "node:test";
import assert from "node:assert/strict";
import { chatWithWebFallback } from "../src/pipeline/web-call.ts";
import type { ChatGateway, ChatRequest, ChatCallOptions } from "../src/gateway/openrouter.ts";
import type { GatewayCallResult } from "../src/types.ts";

function gw(handler: (model: string, req: ChatRequest) => GatewayCallResult) {
  const calls: { req: ChatRequest; opts?: ChatCallOptions }[] = [];
  const gateway: ChatGateway = {
    async chat(req, opts) {
      calls.push({ req, opts });
      return handler(req.model, req);
    },
  };
  return { gateway, calls };
}

const msgs: ChatRequest["messages"] = [{ role: "user", content: "q" }];

test("web disabled: calls the base model once, usedWeb false", async () => {
  const { gateway, calls } = gw(() => ({ content: "x" }));
  const { result, usedWeb } = await chatWithWebFallback(gateway, "m", msgs, { web: false });
  assert.equal(result.content, "x");
  assert.equal(usedWeb, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.req.model, "m");
});

test("web enabled and :online succeeds: usedWeb true, one call", async () => {
  const { gateway, calls } = gw(() => ({ content: "x" }));
  const { usedWeb } = await chatWithWebFallback(gateway, "m", msgs, { web: true });
  assert.equal(usedWeb, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.req.model, "m:online");
});

test("web enabled but :online fails: falls back to base, usedWeb false (§15)", async () => {
  const { gateway, calls } = gw((model) => {
    if (model.endsWith(":online")) throw new Error("web variant unsupported");
    return { content: "fallback" };
  });
  const { result, usedWeb } = await chatWithWebFallback(gateway, "m", msgs, { web: true });
  assert.equal(result.content, "fallback");
  assert.equal(usedWeb, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.req.model, "m:online");
  assert.equal(calls[1]!.req.model, "m");
});

test("web enabled and both attempts fail: error propagates (real model failure)", async () => {
  const { gateway } = gw(() => {
    throw new Error("model down");
  });
  await assert.rejects(() => chatWithWebFallback(gateway, "m", msgs, { web: true }), /model down/);
});

test("passes temperature, maxTokens and signal", async () => {
  const { gateway, calls } = gw(() => ({ content: "x" }));
  const ac = new AbortController();
  await chatWithWebFallback(gateway, "m", msgs, { web: false, temperature: 0.3, maxTokens: 50, signal: ac.signal });
  assert.equal(calls[0]!.req.temperature, 0.3);
  assert.equal(calls[0]!.req.maxTokens, 50);
  assert.equal(calls[0]!.opts?.signal, ac.signal);
});
