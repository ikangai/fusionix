import test from "node:test";
import assert from "node:assert/strict";
import { buildRequest } from "../src/request.ts";
import { parseCliArgs } from "../src/args.ts";

test("default: model 'fusion' with an empty fusion plugin and a user message", () => {
  const { request, webOverride } = buildRequest(parseCliArgs(["hello?"]), "hello?");
  assert.equal(request.model, "fusion");
  assert.deepEqual(request.messages, [{ role: "user", content: "hello?" }]);
  assert.deepEqual(request.plugins, [{ id: "fusion" }]);
  assert.equal(webOverride, undefined);
});

test("--writer sets the top-level model (writer) and keeps a fusion plugin", () => {
  const { request } = buildRequest(parseCliArgs(["q", "--writer", "anthropic/claude-x"]), "q");
  assert.equal(request.model, "anthropic/claude-x");
  assert.equal(request.plugins?.[0]?.id, "fusion");
});

test("maps preset, panel, judge and max-tool-calls into the plugin", () => {
  const args = parseCliArgs(["q", "--preset", "research-high", "--panel", "a,b", "--judge", "J", "--max-tool-calls", "4"]);
  const { request } = buildRequest(args, "q");
  const plugin = request.plugins![0]!;
  assert.equal(plugin.preset, "research-high");
  assert.deepEqual(plugin.analysis_models, ["a", "b"]);
  assert.equal(plugin.model, "J");
  assert.equal(plugin.max_tool_calls, 4);
});

test("--no-web becomes webOverride:false; default leaves it undefined", () => {
  assert.equal(buildRequest(parseCliArgs(["q", "--no-web"]), "q").webOverride, false);
  assert.equal(buildRequest(parseCliArgs(["q"]), "q").webOverride, undefined);
});
