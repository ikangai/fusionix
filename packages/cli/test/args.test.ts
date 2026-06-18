import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../src/args.ts";

test("parses a positional prompt", () => {
  const a = parseCliArgs(["Compare SQLite and Postgres."]);
  assert.equal(a.prompt, "Compare SQLite and Postgres.");
});

test("parses model/preset options and splits --panel CSV", () => {
  const a = parseCliArgs(["q", "--preset", "research-high", "--panel", " a , b ,c", "--judge", "J", "--writer", "W"]);
  assert.equal(a.preset, "research-high");
  assert.deepEqual(a.panel, ["a", "b", "c"]);
  assert.equal(a.judge, "J");
  assert.equal(a.writer, "W");
});

test("web defaults true; --no-web sets it false", () => {
  assert.equal(parseCliArgs(["q"]).web, true);
  assert.equal(parseCliArgs(["q", "--no-web"]).web, false);
});

test("parses numeric flags", () => {
  const a = parseCliArgs(["q", "--max-tool-calls", "5", "--max-cost", "1.5"]);
  assert.equal(a.maxToolCalls, 5);
  assert.equal(a.maxCost, 1.5);
});

test("parses boolean flags and string flags", () => {
  const a = parseCliArgs([
    "q",
    "--local",
    "--stream",
    "--show-analysis",
    "--format",
    "json",
    "--log",
    "run.jsonl",
    "--api-url",
    "https://h/api",
  ]);
  assert.equal(a.local, true);
  assert.equal(a.stream, true);
  assert.equal(a.showAnalysis, true);
  assert.equal(a.format, "json");
  assert.equal(a.log, "run.jsonl");
  assert.equal(a.apiUrl, "https://h/api");
});

test("defaults for booleans are false; prompt undefined when omitted", () => {
  const a = parseCliArgs([]);
  assert.equal(a.local, false);
  assert.equal(a.stream, false);
  assert.equal(a.showAnalysis, false);
  assert.equal(a.version, false);
  assert.equal(a.help, false);
  assert.equal(a.prompt, undefined);
});

test("parses --version and --help", () => {
  assert.equal(parseCliArgs(["--version"]).version, true);
  assert.equal(parseCliArgs(["--help"]).help, true);
});

test("rejects a non-numeric --max-cost instead of silently disabling the cap", () => {
  assert.throws(() => parseCliArgs(["q", "--max-cost", "0.5x"]), /max-cost/);
});

test("rejects a negative or zero --max-cost", () => {
  assert.throws(() => parseCliArgs(["q", "--max-cost", "-5"]), /max-cost/);
  assert.throws(() => parseCliArgs(["q", "--max-cost", "0"]), /max-cost/);
});

test("rejects a non-numeric --max-tool-calls", () => {
  assert.throws(() => parseCliArgs(["q", "--max-tool-calls", "abc"]), /max-tool-calls/);
});
