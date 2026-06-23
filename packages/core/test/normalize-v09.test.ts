import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRequest } from "../src/normalize.ts";
import { isFusionixError } from "../src/errors.ts";
import type { FusionixConfig, FusionixChatCompletionRequest, ChatMessage } from "../src/types.ts";

// v0.9 §22 extensions: provider filtering, writer strategy, topology, routing.

const OPUS = "anthropic/claude-opus-4.8";
const GPT = "openai/gpt-5.2";
const GEMINI = "google/gemini-3.1-pro-preview";

const config: FusionixConfig = {
  gateway: "https://gw/api/v1",
  defaultPreset: "gh",
  defaults: { maxToolCalls: 8, web: true },
  presets: {
    gh: { name: "gh", description: "", panel: [OPUS, GPT, GEMINI], judge: GPT, writer: GPT, web: true, temperature: 0.5 },
  },
};

const RID = { runId: "fusionix-run-test" };
function req(obj: unknown): FusionixChatCompletionRequest {
  return obj as FusionixChatCompletionRequest;
}
function msg(content: string): ChatMessage {
  return { role: "user", content };
}
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`expected throw with code ${code}`);
  } catch (e) {
    assert.ok(isFusionixError(e), `expected FusionixError, got ${String(e)}`);
    assert.equal(e.code, code);
  }
}

// ---- provider filtering (§22.1) -----------------------------------------

test("only_providers keeps only the named providers in the panel", () => {
  const plan = normalizeRequest(
    req({ model: "fusionix", messages: [msg("q")], plugins: [{ id: "fusionix", only_providers: ["openai", "google"] }] }),
    config,
    RID,
  );
  assert.deepEqual(plan.panel, [GPT, GEMINI]);
});

test("exclude_providers drops the named providers from the panel", () => {
  const plan = normalizeRequest(
    req({ model: "fusionix", messages: [msg("q")], plugins: [{ id: "fusionix", exclude_providers: ["anthropic"] }] }),
    config,
    RID,
  );
  assert.deepEqual(plan.panel, [GPT, GEMINI]);
});

test("only + exclude compose (only first, then exclude); case-insensitive", () => {
  const plan = normalizeRequest(
    req({
      model: "fusionix",
      messages: [msg("q")],
      plugins: [{ id: "fusionix", only_providers: ["OpenAI", "Google"], exclude_providers: ["google"] }],
    }),
    config,
    RID,
  );
  assert.deepEqual(plan.panel, [GPT]);
});

test("filtering that empties the panel → invalid_request with a specific message", () => {
  expectCode(
    () =>
      normalizeRequest(
        req({ model: "fusionix", messages: [msg("q")], plugins: [{ id: "fusionix", exclude_providers: ["anthropic", "openai", "google"] }] }),
        config,
        RID,
      ),
    "invalid_request",
  );
});

// ---- writer strategy (§22.2) --------------------------------------------

test("writer_strategy resolves onto the plan; 'fixed' is the absent default", () => {
  const tr = normalizeRequest(
    req({ model: "fusionix", messages: [msg("q")], plugins: [{ id: "fusionix", writer_strategy: "top-ranked" }] }),
    config,
    RID,
  );
  assert.equal(tr.writerStrategy, "top-ranked");
  const fixed = normalizeRequest(
    req({ model: "fusionix", messages: [msg("q")], plugins: [{ id: "fusionix", writer_strategy: "fixed" }] }),
    config,
    RID,
  );
  assert.equal(fixed.writerStrategy, undefined);
});

test("unknown writer_strategy → invalid_request", () => {
  expectCode(
    () =>
      normalizeRequest(
        req({ model: "fusionix", messages: [msg("q")], plugins: [{ id: "fusionix", writer_strategy: "bogus" }] }),
        config,
        RID,
      ),
    "invalid_request",
  );
});

// ---- topology (§22.5) ----------------------------------------------------

test("topology resolves onto the plan; 'standard' is the absent default", () => {
  const debate = normalizeRequest(
    req({ model: "fusionix", messages: [msg("q")], plugins: [{ id: "fusionix", topology: "debate" }] }),
    config,
    RID,
  );
  assert.equal(debate.topology, "debate");
  const std = normalizeRequest(
    req({ model: "fusionix", messages: [msg("q")], plugins: [{ id: "fusionix", topology: "standard" }] }),
    config,
    RID,
  );
  assert.equal(std.topology, undefined);
});

test("unknown topology → invalid_request", () => {
  expectCode(
    () =>
      normalizeRequest(req({ model: "fusionix", messages: [msg("q")], plugins: [{ id: "fusionix", topology: "tree" }] }), config, RID),
    "invalid_request",
  );
});

// ---- routing (§22.4) -----------------------------------------------------

test("route picks the best-fit single model for the detected category and bypasses", () => {
  const mathPlan = normalizeRequest(
    req({ model: "fusionix", messages: [msg("Prove the theorem about polynomial roots")], plugins: [{ id: "fusionix", route: true }] }),
    config,
    RID,
  );
  assert.equal(mathPlan.bypass, true, "routing runs as a single-model call");
  assert.equal(mathPlan.writer, GPT, "math → GPT");
  assert.equal(mathPlan.routeCategory, "math");

  const sciencePlan = normalizeRequest(
    req({ model: "fusionix", messages: [msg("Explain the chemistry of this enzyme reaction")], plugins: [{ id: "fusionix", route: true }] }),
    config,
    RID,
  );
  assert.equal(sciencePlan.writer, GEMINI, "science → Gemini");
  assert.equal(sciencePlan.routeCategory, "science");
});

test("route with an empty pool → invalid_request", () => {
  const emptyConfig: FusionixConfig = { ...config, presets: {}, defaultPreset: undefined };
  expectCode(
    () =>
      normalizeRequest(
        req({ model: "fusionix", messages: [msg("q")], plugins: [{ id: "fusionix", route: true, analysis_models: undefined }] }),
        emptyConfig,
        RID,
      ),
    "invalid_request",
  );
});

test("explicit enabled:false bypass wins over route (route ignored)", () => {
  const plan = normalizeRequest(
    req({ model: GPT, messages: [msg("Prove the theorem")], plugins: [{ id: "fusionix", route: true, enabled: false }] }),
    config,
    RID,
  );
  assert.equal(plan.bypass, true);
  assert.equal(plan.writer, GPT, "explicit single model, not the routed pick");
  assert.equal(plan.routeCategory, undefined, "routing did not run");
});

// ---- preset-level options ------------------------------------------------

test("preset-level writerStrategy/topology/route resolve onto the plan", () => {
  const presetConfig: FusionixConfig = {
    ...config,
    presets: {
      gh: { ...config.presets.gh!, writerStrategy: "capability", topology: "debate" },
    },
  };
  const plan = normalizeRequest(req({ model: "fusionix", messages: [msg("q")] }), presetConfig, RID);
  assert.equal(plan.writerStrategy, "capability");
  assert.equal(plan.topology, "debate");
});
