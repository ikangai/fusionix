import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/main.ts";
import { FusionError } from "@ikangai/fusion-core";
import type { FusionChatCompletionRequest, FusionConfig, FusionRunResult, RunFusionOptions } from "@ikangai/fusion-core";

function sampleResult(overrides: Partial<FusionRunResult> = {}): FusionRunResult {
  return {
    runId: "fusion-run-1",
    answer: "The answer is 42.",
    model: "anthropic/claude-opus-4.8",
    panel: [{ model: "A", answer: "a" }],
    analysis: {
      consensus: ["c"],
      contradictions: [],
      partialCoverage: [],
      uniqueInsights: [],
      blindSpots: [],
      ranking: [],
    },
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    costUsd: 0.12,
    durationMs: 1000,
    web: "used",
    maxToolCallsEnforced: false,
    created: 1730000000,
    ...overrides,
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { request: FusionChatCompletionRequest; opts: RunFusionOptions }[] = [];
  const deps = {
    env: { OPENROUTER_API_KEY: "k" } as Record<string, string | undefined>,
    isTTY: true,
    readStdin: async () => "",
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    runFusion: async (request: FusionChatCompletionRequest, opts: RunFusionOptions) => {
      calls.push({ request, opts });
      return sampleResult();
    },
    version: "9.9.9",
    ...overrides,
  };
  return { deps, calls, out: () => out.join(""), err: () => err.join("") };
}

test("--help prints usage and exits 0", async () => {
  const h = harness();
  const code = await main(["--help"], h.deps);
  assert.equal(code, 0);
  assert.match(h.out(), /fusion/);
  assert.match(h.out(), /--local/);
});

test("--version prints the version", async () => {
  const h = harness();
  const code = await main(["--version"], h.deps);
  assert.equal(code, 0);
  assert.match(h.out(), /9\.9\.9/);
});

test("no prompt and no stdin → exit 2", async () => {
  const h = harness();
  const code = await main(["--local"], h.deps);
  assert.equal(code, 2);
  assert.match(h.err(), /no prompt/i);
});

test("non-local in Phase 1 → exit 2 with guidance", async () => {
  const h = harness();
  const code = await main(["a question"], h.deps);
  assert.equal(code, 2);
  assert.match(h.err(), /--local/);
  assert.equal(h.calls.length, 0);
});

test("local without OPENROUTER_API_KEY → exit 1", async () => {
  const h = harness({ env: {} });
  const code = await main(["q", "--local"], h.deps);
  assert.equal(code, 1);
  assert.match(h.err(), /OPENROUTER_API_KEY/);
});

test("happy path (md on TTY): prints the answer and calls runFusion with the request", async () => {
  const h = harness();
  const code = await main(["Compare X and Y", "--local"], h.deps);
  assert.equal(code, 0);
  assert.match(h.out(), /The answer is 42\./);
  assert.match(h.out(), /cost: \$0\.1200/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.request.model, "fusion");
  assert.equal(h.calls[0]!.request.messages[0]!.content, "Compare X and Y");
  assert.equal(h.calls[0]!.opts.apiKey, "k");
});

test("json by default when output is piped (not a TTY)", async () => {
  const h = harness({ isTTY: false });
  const code = await main(["q", "--local"], h.deps);
  assert.equal(code, 0);
  const parsed = JSON.parse(h.out());
  assert.equal(parsed.object, "chat.completion");
  assert.equal(parsed.choices[0].message.content, "The answer is 42.");
});

test("reads the prompt from stdin when no positional is given", async () => {
  const h = harness({ readStdin: async () => "piped question\n" });
  const code = await main(["--local"], h.deps);
  assert.equal(code, 0);
  assert.equal(h.calls[0]!.request.messages[0]!.content, "piped question");
});

test("a FusionError from runFusion → exit 1 with message and code", async () => {
  const h = harness({
    runFusion: async () => {
      throw new FusionError("all_panel_failed", "All panel models failed.");
    },
  });
  const code = await main(["q", "--local"], h.deps);
  assert.equal(code, 1);
  assert.match(h.err(), /All panel models failed/);
  assert.match(h.err(), /all_panel_failed/);
});

test("--log writes the run record", async () => {
  let written: { path: string; data: string } | undefined;
  const h = harness({ writeFile: async (path: string, data: string) => void (written = { path, data }) });
  const code = await main(["q", "--local", "--log", "run.jsonl"], h.deps);
  assert.equal(code, 0);
  assert.equal(written?.path, "run.jsonl");
  assert.match(written!.data, /chat\.completion/);
});

test("--stream streams writer deltas to stdout", async () => {
  const h = harness({
    runFusion: async (_req: FusionChatCompletionRequest, opts: RunFusionOptions) => {
      opts.onWriterDelta?.("Hel");
      opts.onWriterDelta?.("lo");
      return sampleResult({ answer: "Hello" });
    },
  });
  const code = await main(["q", "--local", "--stream"], h.deps);
  assert.equal(code, 0);
  assert.match(h.out(), /Hello/);
  assert.match(h.out(), /cost: \$0\.1200/); // extras footer still printed
});

test("--stream --show-analysis streams the answer, then prints analysis and footer in order", async () => {
  const h = harness({
    runFusion: async (_req: FusionChatCompletionRequest, opts: RunFusionOptions) => {
      opts.onWriterDelta?.("Hel");
      opts.onWriterDelta?.("lo");
      return sampleResult({ answer: "Hello" });
    },
  });
  const code = await main(["q", "--local", "--stream", "--show-analysis"], h.deps);
  assert.equal(code, 0);
  const out = h.out();
  assert.match(out, /Hello/);
  assert.match(out, /Judge analysis/);
  assert.match(out, /cost: \$0\.1200/);
  assert.ok(out.indexOf("Hello") < out.indexOf("Judge analysis"), "answer streamed before analysis");
});

test("--stream falls back to a full render when no deltas are emitted", async () => {
  const h = harness({ runFusion: async () => sampleResult() }); // never calls onWriterDelta
  const code = await main(["q", "--local", "--stream"], h.deps);
  assert.equal(code, 0);
  assert.match(h.out(), /The answer is 42\./); // full answer still printed
  assert.match(h.out(), /cost: \$0\.1200/);
});

test("--no-web sets webOverride false in run options", async () => {
  const h = harness();
  await main(["q", "--local", "--no-web"], h.deps);
  assert.equal(h.calls[0]!.opts.webOverride, false);
});

const smallConfig: FusionConfig = {
  gateway: "https://gw/api/v1",
  defaultPreset: "p",
  defaults: { maxToolCalls: 8, web: true },
  presets: { p: { name: "p", description: "", panel: ["A"], judge: "A", writer: "A", web: false } },
};

test("--max-cost aborts before running when the estimate exceeds the cap", async () => {
  const h = harness({
    loadConfig: async () => smallConfig,
    loadPrices: async () => ({ A: { prompt: 1, completion: 1 } }), // absurdly expensive
  });
  const code = await main(["q", "--local", "--max-cost", "0.0001"], h.deps);
  assert.equal(code, 1);
  assert.match(h.err(), /exceeds --max-cost/);
  assert.equal(h.calls.length, 0, "must not run when aborted");
});

test("--max-cost warns and proceeds when prices are unknown", async () => {
  const h = harness({
    loadConfig: async () => smallConfig,
    loadPrices: async () => ({}), // no prices known
  });
  const code = await main(["q", "--local", "--max-cost", "0.0001"], h.deps);
  assert.equal(code, 0);
  assert.match(h.err(), /price unknown|cannot enforce|unavailable/i);
  assert.equal(h.calls.length, 1, "proceeds when estimation unavailable");
});
