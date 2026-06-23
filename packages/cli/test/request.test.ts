import test from "node:test";
import assert from "node:assert/strict";
import { buildRequest } from "../src/request.ts";
import { parseCliArgs } from "../src/args.ts";

test("default: model 'fusionix' with an empty fusionix plugin and a user message", () => {
  const { request, webOverride } = buildRequest(parseCliArgs(["hello?"]), "hello?");
  assert.equal(request.model, "fusionix");
  assert.deepEqual(request.messages, [{ role: "user", content: "hello?" }]);
  assert.deepEqual(request.plugins, [{ id: "fusionix" }]);
  assert.equal(webOverride, undefined);
});

test("--writer sets the top-level model (writer) and keeps a fusionix plugin", () => {
  const { request } = buildRequest(parseCliArgs(["q", "--writer", "anthropic/claude-x"]), "q");
  assert.equal(request.model, "anthropic/claude-x");
  assert.equal(request.plugins?.[0]?.id, "fusionix");
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

test("v0.9: maps provider filters, writer-strategy, topology and route into the plugin (§22)", () => {
  const args = parseCliArgs([
    "q",
    "--only-provider", "openai,google",
    "--exclude-provider", "anthropic",
    "--writer-strategy", "top-ranked",
    "--topology", "debate",
    "--route",
  ]);
  const plugin = buildRequest(args, "q").request.plugins![0]!;
  assert.deepEqual(plugin.only_providers, ["openai", "google"]);
  assert.deepEqual(plugin.exclude_providers, ["anthropic"]);
  assert.equal(plugin.writer_strategy, "top-ranked");
  assert.equal(plugin.topology, "debate");
  assert.equal(plugin.route, true);
});

test("v0.9: --mode fast is sugar for routing; --mode deliberate does not route", () => {
  assert.equal(buildRequest(parseCliArgs(["q", "--mode", "fast"]), "q").request.plugins![0]!.route, true);
  assert.equal(buildRequest(parseCliArgs(["q", "--mode", "deliberate"]), "q").request.plugins![0]!.route, undefined);
});
