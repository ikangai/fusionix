import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRequest } from "../src/normalize.ts";
import { isFusionError } from "../src/errors.ts";
import type { FusionConfig, FusionChatCompletionRequest, ChatMessage } from "../src/types.ts";

const config: FusionConfig = {
  gateway: "https://gw/api/v1",
  defaultPreset: "general-high",
  defaults: { maxToolCalls: 8, web: true },
  presets: {
    "general-high": { name: "general-high", description: "", panel: ["A", "B", "C"], judge: "J", writer: "W", web: true, temperature: 0.5 },
    "research-high": {
      name: "research-high",
      description: "",
      panel: ["R1", "R2"],
      judge: "RJ",
      writer: "RW",
      web: true,
      temperature: 0.4,
      panelSystem: "PS",
      judgeSystem: "JS",
      writerSystem: "WS",
    },
    "code-review": { name: "code-review", description: "", panel: ["CA", "CB"], judge: "CJ", writer: "CW", web: false, temperature: 0.2 },
  },
};

const user: ChatMessage = { role: "user", content: "q" };
const RID = { runId: "fusion-run-test" };

function req(obj: unknown): FusionChatCompletionRequest {
  return obj as FusionChatCompletionRequest;
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`expected throw with code ${code}`);
  } catch (e) {
    assert.ok(isFusionError(e), `expected FusionError, got ${String(e)}`);
    assert.equal(e.code, code);
  }
}

// ---- resolution ----------------------------------------------------------

test("default fusion request resolves to the default preset", () => {
  const plan = normalizeRequest(req({ model: "fusion", messages: [user] }), config, RID);
  assert.deepEqual(plan.panel, ["A", "B", "C"]);
  assert.equal(plan.judge, "J");
  assert.equal(plan.writer, "W");
  assert.equal(plan.web, true);
  assert.equal(plan.bypass, false);
  assert.equal(plan.maxToolCalls, 8);
  assert.equal(plan.panelTemperature, 0.5);
  assert.equal(plan.judgeTemperature, 0.5);
  assert.equal(plan.writerTemperature, 0.5);
  assert.equal(plan.presetName, "general-high");
  assert.equal(plan.runId, "fusion-run-test");
});

test("implicit plugin: model 'fusion' with no plugins uses deployment defaults", () => {
  const plan = normalizeRequest(req({ model: "fusion", messages: [user] }), config, RID);
  assert.deepEqual(plan.panel, ["A", "B", "C"]);
  assert.equal(plan.judge, "J");
});

test("plugin.preset selects the preset and its system prompts", () => {
  const plan = normalizeRequest(
    req({ model: "fusion", messages: [user], plugins: [{ id: "fusion", preset: "research-high" }] }),
    config,
    RID,
  );
  assert.deepEqual(plan.panel, ["R1", "R2"]);
  assert.equal(plan.judge, "RJ");
  assert.equal(plan.writer, "RW");
  assert.equal(plan.panelSystem, "PS");
  assert.equal(plan.judgeSystem, "JS");
  assert.equal(plan.writerSystem, "WS");
  assert.equal(plan.panelTemperature, 0.4);
});

test("analysis_models overrides the preset panel (§6.8)", () => {
  const plan = normalizeRequest(
    req({ model: "fusion", messages: [user], plugins: [{ id: "fusion", preset: "research-high", analysis_models: ["X", "Y", "Z"] }] }),
    config,
    RID,
  );
  assert.deepEqual(plan.panel, ["X", "Y", "Z"]);
  assert.equal(plan.judge, "RJ"); // judge still from preset
});

test("plugin.model overrides the judge", () => {
  const plan = normalizeRequest(
    req({ model: "fusion", messages: [user], plugins: [{ id: "fusion", model: "OJ" }] }),
    config,
    RID,
  );
  assert.equal(plan.judge, "OJ");
  assert.deepEqual(plan.panel, ["A", "B", "C"]);
  assert.equal(plan.writer, "W");
});

test("concrete top-level model is the writer; plugin.model is the judge (§6.8 example)", () => {
  const plan = normalizeRequest(
    req({ model: "anthropic/claude-x", messages: [user], plugins: [{ id: "fusion", model: "openai/gpt-y" }] }),
    config,
    RID,
  );
  assert.equal(plan.writer, "anthropic/claude-x");
  assert.equal(plan.judge, "openai/gpt-y");
  assert.deepEqual(plan.panel, ["A", "B", "C"]); // panel from default preset
  assert.equal(plan.bypass, false);
});

test("enabled:false bypasses with a concrete writer", () => {
  const plan = normalizeRequest(
    req({ model: "openai/gpt-z", messages: [user], plugins: [{ id: "fusion", enabled: false }] }),
    config,
    RID,
  );
  assert.equal(plan.bypass, true);
  assert.equal(plan.writer, "openai/gpt-z");
});

test("enabled:false with model 'fusion' bypasses using the default writer", () => {
  const plan = normalizeRequest(
    req({ model: "fusion", messages: [user], plugins: [{ id: "fusion", enabled: false }] }),
    config,
    RID,
  );
  assert.equal(plan.bypass, true);
  assert.equal(plan.writer, "W");
});

test("request temperature/max_tokens apply to the writer only", () => {
  const plan = normalizeRequest(
    req({ model: "fusion", messages: [user], temperature: 0.9, max_tokens: 1000 }),
    config,
    RID,
  );
  assert.equal(plan.writerTemperature, 0.9);
  assert.equal(plan.writerMaxTokens, 1000);
  assert.equal(plan.panelTemperature, 0.5); // preset default, not overridden
  assert.equal(plan.judgeTemperature, 0.5);
});

test("plugin.max_tool_calls overrides the default", () => {
  const plan = normalizeRequest(
    req({ model: "fusion", messages: [user], plugins: [{ id: "fusion", max_tool_calls: 3 }] }),
    config,
    RID,
  );
  assert.equal(plan.maxToolCalls, 3);
});

test("webOverride forces web on/off regardless of preset", () => {
  const off = normalizeRequest(req({ model: "fusion", messages: [user] }), config, { ...RID, webOverride: false });
  assert.equal(off.web, false);
  const onForCodeReview = normalizeRequest(
    req({ model: "fusion", messages: [user], plugins: [{ id: "fusion", preset: "code-review" }] }),
    config,
    { ...RID, webOverride: true },
  );
  assert.equal(onForCodeReview.web, true); // code-review preset has web:false
});

test("caller messages are preserved (developer folded) in the plan", () => {
  const plan = normalizeRequest(
    req({ model: "fusion", messages: [{ role: "system", content: "S" }, { role: "developer", content: "D" }, user] }),
    config,
    RID,
  );
  assert.equal(plan.messages.length, 3);
  assert.equal(plan.messages[0]!.role, "system");
  assert.equal(plan.messages[1]!.role, "system"); // developer folded
  assert.equal(plan.messages[2]!.role, "user");
});

test("runId is auto-generated when not supplied", () => {
  const plan = normalizeRequest(req({ model: "fusion", messages: [user] }), config);
  assert.match(plan.runId, /^fusion-run-/);
});

// ---- validation ----------------------------------------------------------

test("missing messages → invalid_request", () => {
  expectCode(() => normalizeRequest(req({ model: "fusion" }), config, RID), "invalid_request");
});

test("empty messages → invalid_request", () => {
  expectCode(() => normalizeRequest(req({ model: "fusion", messages: [] }), config, RID), "invalid_request");
});

test("no user message → invalid_request", () => {
  expectCode(
    () => normalizeRequest(req({ model: "fusion", messages: [{ role: "assistant", content: "x" }] }), config, RID),
    "invalid_request",
  );
});

test("analysis_models present but empty → invalid_request", () => {
  expectCode(
    () => normalizeRequest(req({ model: "fusion", messages: [user], plugins: [{ id: "fusion", analysis_models: [] }] }), config, RID),
    "invalid_request",
  );
});

test("more than one fusion plugin → invalid_request", () => {
  expectCode(
    () => normalizeRequest(req({ model: "fusion", messages: [user], plugins: [{ id: "fusion" }, { id: "fusion" }] }), config, RID),
    "invalid_request",
  );
});

test("concrete model with no fusion plugin → not_a_fusion_request", () => {
  expectCode(() => normalizeRequest(req({ model: "openai/x", messages: [user] }), config, RID), "not_a_fusion_request");
});

test("concrete model with only a non-fusion plugin → not_a_fusion_request", () => {
  expectCode(
    () => normalizeRequest(req({ model: "openai/x", messages: [user], plugins: [{ id: "web" }] }), config, RID),
    "not_a_fusion_request",
  );
});

test("max_tool_calls must be a positive integer", () => {
  for (const bad of [0, -1, 1.5, "3"]) {
    expectCode(
      () => normalizeRequest(req({ model: "fusion", messages: [user], plugins: [{ id: "fusion", max_tool_calls: bad }] }), config, RID),
      "invalid_request",
    );
  }
});

test("stream must be a boolean", () => {
  expectCode(() => normalizeRequest(req({ model: "fusion", messages: [user], stream: "yes" }), config, RID), "invalid_request");
});

test("unknown preset → invalid_request", () => {
  expectCode(
    () => normalizeRequest(req({ model: "fusion", messages: [user], plugins: [{ id: "fusion", preset: "nope" }] }), config, RID),
    "invalid_request",
  );
});

test("empty resolved panel (no preset, no analysis_models) → invalid_request", () => {
  const bare: FusionConfig = { gateway: "g", defaults: { maxToolCalls: 8, web: true }, presets: {} };
  expectCode(() => normalizeRequest(req({ model: "fusion", messages: [user] }), bare, RID), "invalid_request");
});

test("missing judge (panel provided, no preset) → invalid_request", () => {
  const bare: FusionConfig = { gateway: "g", defaults: { maxToolCalls: 8, web: true }, presets: {} };
  expectCode(
    () => normalizeRequest(req({ model: "fusion", messages: [user], plugins: [{ id: "fusion", analysis_models: ["X"] }] }), bare, RID),
    "invalid_request",
  );
});

test("bypass requires only a writer — empty panel is allowed", () => {
  const bare: FusionConfig = { gateway: "g", defaults: { maxToolCalls: 8, web: true }, presets: {} };
  const plan = normalizeRequest(
    req({ model: "openai/x", messages: [user], plugins: [{ id: "fusion", enabled: false }] }),
    bare,
    RID,
  );
  assert.equal(plan.bypass, true);
  assert.equal(plan.writer, "openai/x");
  assert.deepEqual(plan.panel, []);
});
