import test from "node:test";
import assert from "node:assert/strict";
import { OpenRouterGateway } from "../src/gateway/openrouter.ts";
import { applyWeb } from "../src/gateway/web.ts";
import { isFusionError } from "../src/errors.ts";

interface FakeResult {
  status?: number;
  body: unknown;
}

function fakeFetch(handler: (url: string, init: RequestInit) => FakeResult) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: unknown, init: unknown) => {
    const i = (init ?? {}) as RequestInit;
    calls.push({ url: String(url), init: i });
    const { status = 200, body } = handler(String(url), i);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("applyWeb appends :online only when web is enabled and not already present", () => {
  assert.equal(applyWeb("anthropic/claude-opus-4.8", true), "anthropic/claude-opus-4.8:online");
  assert.equal(applyWeb("anthropic/claude-opus-4.8", false), "anthropic/claude-opus-4.8");
  assert.equal(applyWeb("anthropic/claude-opus-4.8:online", true), "anthropic/claude-opus-4.8:online");
});

test("chat() POSTs to /chat/completions with usage accounting and auth", async () => {
  const { fn, calls } = fakeFetch(() => ({
    body: {
      id: "gen-1",
      model: "m",
      choices: [{ message: { role: "assistant", content: "hello" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 },
    },
  }));
  const gw = new OpenRouterGateway({ apiKey: "KEY", baseUrl: "https://gw/api/v1", fetch: fn });
  const res = await gw.chat({ model: "m:online", messages: [{ role: "user", content: "q" }], temperature: 0.5, maxTokens: 100 });

  assert.equal(res.content, "hello");
  assert.deepEqual(res.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 });
  assert.equal(res.id, "gen-1");

  const call = calls[0]!;
  assert.equal(call.url, "https://gw/api/v1/chat/completions");
  assert.equal(call.init.method, "POST");
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("authorization"), "Bearer KEY");
  const body = JSON.parse(call.init.body as string);
  assert.equal(body.model, "m:online");
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.temperature, 0.5);
  assert.equal(body.max_tokens, 100);
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].content, "q");
});

test("chat() sends OpenRouter attribution headers only when configured", async () => {
  const withAttr = fakeFetch(() => ({ body: { choices: [{ message: { content: "x" } }] } }));
  const gw1 = new OpenRouterGateway({
    apiKey: "K",
    baseUrl: "https://gw/api/v1",
    fetch: withAttr.fn,
    referer: "https://fusion.ikangai.com",
    title: "Fusion",
    categories: "cli-agent",
  });
  await gw1.chat({ model: "m", messages: [{ role: "user", content: "q" }] });
  const h1 = new Headers(withAttr.calls[0]!.init.headers);
  assert.equal(h1.get("http-referer"), "https://fusion.ikangai.com");
  assert.equal(h1.get("x-openrouter-title"), "Fusion");
  assert.equal(h1.get("x-title"), "Fusion");
  assert.equal(h1.get("x-openrouter-categories"), "cli-agent");

  const noAttr = fakeFetch(() => ({ body: { choices: [{ message: { content: "x" } }] } }));
  const gw2 = new OpenRouterGateway({ apiKey: "K", baseUrl: "https://gw/api/v1", fetch: noAttr.fn });
  await gw2.chat({ model: "m", messages: [{ role: "user", content: "q" }] });
  const h2 = new Headers(noAttr.calls[0]!.init.headers);
  assert.equal(h2.get("http-referer"), null);
  assert.equal(h2.get("x-openrouter-title"), null);
});

test("chat() omits temperature/max_tokens when not provided", async () => {
  const { fn, calls } = fakeFetch(() => ({ body: { choices: [{ message: { content: "x" } }] } }));
  const gw = new OpenRouterGateway({ apiKey: "K", baseUrl: "https://gw/api/v1", fetch: fn });
  await gw.chat({ model: "m", messages: [{ role: "user", content: "q" }] });
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.ok(!("temperature" in body));
  assert.ok(!("max_tokens" in body));
});

test("chat() flattens content-part array responses to text", async () => {
  const { fn } = fakeFetch(() => ({
    body: { choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] },
  }));
  const gw = new OpenRouterGateway({ apiKey: "K", baseUrl: "https://gw/api/v1", fetch: fn });
  const res = await gw.chat({ model: "m", messages: [{ role: "user", content: "q" }] });
  assert.equal(res.content, "a\nb");
});

test("chat() passes the abort signal to fetch", async () => {
  const { fn, calls } = fakeFetch(() => ({ body: { choices: [{ message: { content: "x" } }] } }));
  const gw = new OpenRouterGateway({ apiKey: "K", baseUrl: "https://gw/api/v1", fetch: fn });
  const ac = new AbortController();
  await gw.chat({ model: "m", messages: [{ role: "user", content: "q" }] }, { signal: ac.signal });
  assert.equal(calls[0]!.init.signal, ac.signal);
});

test("chat() maps a non-2xx response to gateway_error (502, no key state leaked)", async () => {
  const { fn } = fakeFetch(() => ({ status: 401, body: { error: { message: "No auth credentials found" } } }));
  const gw = new OpenRouterGateway({ apiKey: "K", baseUrl: "https://gw/api/v1", fetch: fn });
  await assert.rejects(
    () => gw.chat({ model: "m", messages: [{ role: "user", content: "q" }] }),
    (err: unknown) => isFusionError(err) && err.code === "gateway_error" && err.httpStatus === 502,
  );
});

test("listModels() parses the data array and is best-effort on failure", async () => {
  const ok = fakeFetch(() => ({ body: { data: [{ id: "a", pricing: { prompt: "0.001", completion: "0.002" } }] } }));
  const gw = new OpenRouterGateway({ apiKey: "K", baseUrl: "https://gw/api/v1", fetch: ok.fn });
  const models = await gw.listModels();
  assert.equal(models?.[0]?.id, "a");
  assert.equal(models?.[0]?.pricing?.completion, "0.002");

  const bad = fakeFetch(() => ({ status: 500, body: {} }));
  const gw2 = new OpenRouterGateway({ apiKey: "K", baseUrl: "https://gw/api/v1", fetch: bad.fn });
  assert.equal(await gw2.listModels(), undefined);

  const thrower = (async () => {
    throw new Error("network");
  }) as unknown as typeof fetch;
  const gw3 = new OpenRouterGateway({ apiKey: "K", baseUrl: "https://gw/api/v1", fetch: thrower });
  assert.equal(await gw3.listModels(), undefined);
});

test("getGeneration() returns cost best-effort", async () => {
  const ok = fakeFetch(() => ({ body: { data: { total_cost: 0.005 } } }));
  const gw = new OpenRouterGateway({ apiKey: "K", baseUrl: "https://gw/api/v1", fetch: ok.fn });
  assert.equal((await gw.getGeneration("gen-1"))?.cost, 0.005);

  const bad = fakeFetch(() => ({ status: 404, body: {} }));
  const gw2 = new OpenRouterGateway({ apiKey: "K", baseUrl: "https://gw/api/v1", fetch: bad.fn });
  assert.equal(await gw2.getGeneration("x"), undefined);
});
