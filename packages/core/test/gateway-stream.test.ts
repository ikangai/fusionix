import test from "node:test";
import assert from "node:assert/strict";
import { OpenRouterGateway } from "../src/gateway/openrouter.ts";
import { isFusionError } from "../src/errors.ts";
import type { GatewayCallResult } from "../src/types.ts";

function sseFetch(sse: string, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return new Response(sse, { status, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const SSE = [
  'data: {"choices":[{"delta":{"content":"Hel"}}]}',
  "",
  ": OPENROUTER PROCESSING",
  'data: {"choices":[{"delta":{"content":"lo"}}]}',
  "",
  'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"cost":0.01},"id":"gen-1","model":"m"}',
  "",
  "data: [DONE]",
  "",
].join("\n");

test("streamChat yields content deltas and returns the final result with usage", async () => {
  const { fn, calls } = sseFetch(SSE);
  const gw = new OpenRouterGateway({ apiKey: "K", baseUrl: "https://gw/api/v1", fetch: fn });
  const gen = gw.streamChat({ model: "m", messages: [{ role: "user", content: "q" }] });

  const deltas: string[] = [];
  let final: GatewayCallResult;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      final = next.value;
      break;
    }
    deltas.push(next.value);
  }

  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.equal(final.content, "Hello");
  assert.equal(final.usage?.cost, 0.01);
  assert.equal(final.usage?.total_tokens, 5);
  assert.equal(final.id, "gen-1");

  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal(body.stream, true);
  assert.deepEqual(body.usage, { include: true });
});

test("streamChat maps a non-2xx to gateway_error", async () => {
  const { fn } = sseFetch("", 500);
  const gw = new OpenRouterGateway({ apiKey: "K", baseUrl: "https://gw/api/v1", fetch: fn });
  const gen = gw.streamChat({ model: "m", messages: [{ role: "user", content: "q" }] });
  await assert.rejects(
    () => gen.next(),
    (err: unknown) => isFusionError(err) && err.code === "gateway_error",
  );
});
