/**
 * QA driver — runs the full inventory (docs/qa/inventory-acceptance.md) "as a real user".
 *
 *  - bin "cli":     spawns the GENUINE bin (packages/cli/src/index.ts) for offline paths
 *                   (help/version/arg errors/mode gating) that never reach the gateway.
 *  - bin "harness": spawns qa/run.ts (real main + real pipeline + FAKE gateway) for every
 *                   path that exercises the panel→judge→writer pipeline.
 *
 * Captures exit code, stdout, stderr (and any --log file) per case, asserts the acceptance
 * criteria, writes evidence to qa/out/<id>.log, prints a summary, and exits nonzero on any
 * unexpected result. Re-run anytime: `node qa/drive.mjs`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "qa", "out");
mkdirSync(OUT, { recursive: true });

const NODE_FLAGS = ["--conditions=development"];
const CLI = join(ROOT, "packages", "cli", "src", "index.ts");
const HARNESS = join(ROOT, "qa", "run.ts");

function run({ bin, args = [], env = {}, input, scenario, tty }) {
  const file = bin === "cli" ? CLI : HARNESS;
  const fullEnv = { ...process.env, OPENROUTER_API_KEY: "sk-test", ...env };
  if (bin === "harness") {
    fullEnv.QA_SCENARIO = JSON.stringify(scenario ?? {});
    fullEnv.QA_TTY = tty ? "1" : "0";
  }
  const r = spawnSync("node", [...NODE_FLAGS, file, ...args], {
    cwd: ROOT,
    env: fullEnv,
    input: input ?? "",
    encoding: "utf8",
    timeout: 30000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

const cases = [];
function test(spec) { cases.push(spec); }

const inc = (hay, needle) => hay.includes(needle);

// ----- A. invocation & meta (genuine bin) -----
test({ id: "A1", desc: "--help prints usage, exit 0", bin: "cli", args: ["--help"],
  check: (r) => r.status === 0 && inc(r.stdout, "multi-model deliberation") && inc(r.stdout, "--preset") });
test({ id: "A2", desc: "--version prints version, exit 0", bin: "cli", args: ["--version"],
  check: (r) => r.status === 0 && /\d+\.\d+\.\d+/.test(r.stdout) });
test({ id: "A3", desc: "no prompt no stdin -> exit 2", bin: "cli", args: ["--local"],
  check: (r) => r.status === 2 && inc(r.stderr, "no prompt provided") });
test({ id: "A4", desc: "unknown flag -> exit 2", bin: "cli", args: ["hi", "--bogus", "--local"],
  check: (r) => r.status === 2 && /[Uu]nknown option|--bogus/.test(r.stderr) });
test({ id: "EC-A4a", desc: "mistyped flag --pannel -> exit 2", bin: "cli", args: ["hi", "--pannel", "x", "--local"],
  check: (r) => r.status === 2 });
test({ id: "EC-A2a", desc: "--help wins over --version", bin: "cli", args: ["--help", "--version"],
  check: (r) => r.status === 0 && inc(r.stdout, "Usage") });

// ----- B. prompt input -----
test({ id: "B2", desc: "multiple positionals joined", bin: "harness", tty: true, args: ["Compare", "SQLite", "and", "Postgres", "--local", "--preset", "general-budget"],
  check: (r) => r.status === 0 && inc(r.stdout, "FINAL ANSWER") });
test({ id: "B3", desc: "piped stdin used as prompt", bin: "harness", input: "What is X via stdin?\n", args: ["--local", "--preset", "general-budget"],
  check: (r) => r.status === 0 && inc(r.stdout, "FINAL ANSWER") });
test({ id: "B4", desc: "positional wins over stdin (no hang)", bin: "harness", tty: true, input: "STDIN PROMPT\n", args: ["POSITIONAL PROMPT", "--local", "--preset", "general-budget"],
  check: (r) => r.status === 0 && inc(r.stdout, "FINAL ANSWER") });
test({ id: "B5", desc: "whitespace-only positional -> exit 2", bin: "harness", args: ["   ", "--local"],
  check: (r) => r.status === 2 && inc(r.stderr, "no prompt provided") });
test({ id: "EC-B3a", desc: "empty stdin -> exit 2", bin: "harness", input: "", args: ["--local"],
  check: (r) => r.status === 2 && inc(r.stderr, "no prompt provided") });
test({ id: "B6", desc: "production-scale ~50KB stdin runs", bin: "harness", input: readFileSync(join(ROOT, "qa/fixtures/large-prompt.md"), "utf8"), args: ["--local", "--preset", "general-budget"],
  check: (r) => r.status === 0 && inc(r.stdout, "FINAL ANSWER") });
test({ id: "B7", desc: "unicode/newlines preserved", bin: "harness", tty: true, args: ["héllo 世界 — \"quotes\" & $shell `cmd`", "--local", "--preset", "general-budget"],
  check: (r) => r.status === 0 && inc(r.stdout, "FINAL ANSWER") });

// ----- C. mode gating (genuine bin) -----
test({ id: "C1", desc: "no --local -> hosted unavailable exit 2", bin: "cli", args: ["hi"],
  check: (r) => r.status === 2 && inc(r.stderr, "hosted mode is not available") });
test({ id: "C2", desc: "--local no key -> exit 1", bin: "cli", args: ["hi", "--local"], env: { OPENROUTER_API_KEY: "" },
  check: (r) => r.status === 1 && inc(r.stderr, "OPENROUTER_API_KEY is not set") });
test({ id: "C4", desc: "--api-url with --local warns, still runs", bin: "harness", tty: true, args: ["hi", "--local", "--api-url", "https://x", "--preset", "general-budget"],
  check: (r) => r.status === 0 && inc(r.stderr, "--api-url is ignored") && inc(r.stdout, "FINAL ANSWER") });
test({ id: "EC-C1a", desc: "--help works without --local/key", bin: "cli", args: ["--help"], env: { OPENROUTER_API_KEY: "" },
  check: (r) => r.status === 0 });

// ----- D. presets -----
for (const p of ["general-high","general-budget","research-high","research-budget","code-review","architecture-review"]) {
  test({ id: `D1-${p}`, desc: `preset ${p} resolves & runs`, bin: "harness", args: ["q", "--local", "--preset", p, "--format", "json"],
    check: (r) => r.status === 0 && JSON.parse(r.stdout).fusionix.panel.length === 3 });
}
test({ id: "D2", desc: "default preset general-high", bin: "harness", tty: true, args: ["q", "--local"],
  check: (r) => r.status === 0 && inc(r.stdout, "anthropic/claude-opus-4.8") });
test({ id: "D3", desc: "unknown preset -> nonzero", bin: "harness", args: ["q", "--local", "--preset", "bogus"],
  check: (r) => r.status !== 0 && inc(r.stderr, "Unknown preset") });
test({ id: "D4", desc: "FUSIONIX_DEFAULT_PRESET override", bin: "harness", tty: true, args: ["q", "--local"], env: { FUSIONIX_DEFAULT_PRESET: "general-budget" },
  check: (r) => r.status === 0 && inc(r.stdout, "claude-haiku-4.5") });
test({ id: "D5", desc: "bad FUSIONIX_DEFAULT_PRESET -> fail fast nonzero", bin: "harness", args: ["q", "--local"], env: { FUSIONIX_DEFAULT_PRESET: "missing" },
  check: (r) => r.status !== 0 });
test({ id: "EC-D1a", desc: "code-review web:false -> web off", bin: "harness", args: ["q", "--local", "--preset", "code-review", "--format", "json"],
  check: (r) => r.status === 0 && JSON.parse(r.stdout).fusionix.web === "off" });

// ----- E. model overrides -----
test({ id: "E1", desc: "--panel overrides + order", bin: "harness", args: ["q", "--local", "--panel", "m1,m2,m3", "--judge", "jX", "--writer", "wY", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status === 0 && j.fusionix.panel.map(p=>p.model).join(",") === "m1,m2,m3"; } });
test({ id: "E3", desc: "csv trimming a, b ,c,", bin: "harness", args: ["q", "--local", "--panel", "a, b ,c,", "--judge", "j", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status === 0 && j.fusionix.panel.map(p=>p.model).join("|") === "a|b|c"; } });
test({ id: "E4", desc: "--panel empty string ignored (preset panel)", bin: "harness", args: ["q", "--local", "--preset", "general-budget", "--panel", "", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status === 0 && j.fusionix.panel.length === 3; } });
test({ id: "E5", desc: "--panel ' , ' -> invalid_request nonzero", bin: "harness", args: ["q", "--local", "--panel", " , "],
  check: (r) => r.status !== 0 && inc(r.stderr, "analysis_models") });
test({ id: "E6", desc: "--writer concrete model becomes writer", bin: "harness", args: ["q", "--local", "--preset", "general-budget", "--writer", "concrete/model", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status === 0 && j.model === "fusionix" && j.fusionix.panel.length===3; } });

// ----- F. web -----
test({ id: "F2", desc: "--no-web -> web off", bin: "harness", args: ["q", "--local", "--preset", "general-budget", "--no-web", "--format", "json"],
  check: (r) => r.status === 0 && JSON.parse(r.stdout).fusionix.web === "off" });
test({ id: "F3", desc: "web on, :online ok -> used", bin: "harness", args: ["q", "--local", "--preset", "general-budget", "--format", "json"],
  check: (r) => r.status === 0 && JSON.parse(r.stdout).fusionix.web === "used" });
test({ id: "F4", desc: "web on, :online fails -> unsupported, still ok", bin: "harness", scenario: { panel: { onlineFails: true } }, args: ["q", "--local", "--preset", "general-budget", "--format", "json"],
  check: (r) => r.status === 0 && JSON.parse(r.stdout).fusionix.web === "unsupported" });

// ----- G. output formats -----
test({ id: "G1", desc: "--format md", bin: "harness", args: ["q", "--local", "--preset", "general-budget", "--format", "md"],
  check: (r) => r.status === 0 && inc(r.stdout, "FINAL ANSWER") && /_panel:.*cost:.*fusionix-run-/.test(r.stdout) });
test({ id: "G2", desc: "--format json wire shape", bin: "harness", args: ["q", "--local", "--preset", "general-budget", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status===0 && j.object==="chat.completion" && j.choices[0].message.content.includes("FINAL") && j.fusionix.analysis.partial_coverage !== undefined; } });
test({ id: "G3", desc: "--format text", bin: "harness", args: ["q", "--local", "--preset", "general-budget", "--format", "text"],
  check: (r) => r.status === 0 && inc(r.stdout, "FINAL ANSWER") && !inc(r.stdout, "##") });
test({ id: "G4-tty", desc: "TTY default = md", bin: "harness", tty: true, args: ["q", "--local", "--preset", "general-budget"],
  check: (r) => r.status === 0 && inc(r.stdout, "---") });
test({ id: "G4-pipe", desc: "pipe default = json", bin: "harness", tty: false, args: ["q", "--local", "--preset", "general-budget"],
  check: (r) => r.status === 0 && r.stdout.trim().startsWith("{") });
test({ id: "G5", desc: "--format xml -> exit 2", bin: "cli", args: ["q", "--local", "--format", "xml"],
  check: (r) => r.status === 2 && inc(r.stderr, "invalid --format") });
test({ id: "G6", desc: "--show-analysis md", bin: "harness", tty: true, args: ["q", "--local", "--preset", "general-budget", "--show-analysis"],
  check: (r) => r.status === 0 && inc(r.stdout, "Judge analysis") && inc(r.stdout, "Consensus") });
test({ id: "G7", desc: "--show-analysis + json: no crash, full json", bin: "harness", args: ["q", "--local", "--preset", "general-budget", "--show-analysis", "--format", "json"],
  check: (r) => r.status === 0 && JSON.parse(r.stdout).fusionix.analysis.consensus.length >= 1 });
test({ id: "G2b", desc: "cost_usd null when no cost (json)", bin: "harness", scenario: { noCost: true }, args: ["q", "--local", "--preset", "general-budget", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status===0 && j.fusionix.cost_usd === null; } });

// ----- H. streaming -----
test({ id: "H1", desc: "--stream md streams then footer", bin: "harness", tty: true, scenario: { writer: { stream: true, mode: "text" } }, args: ["q", "--local", "--preset", "general-budget", "--stream"],
  check: (r) => r.status === 0 && inc(r.stdout, "FINAL ANSWER") && /fusionix-run-/.test(r.stdout) });
test({ id: "H2", desc: "--stream + json suppresses streaming", bin: "harness", scenario: { writer: { stream: true } }, args: ["q", "--local", "--preset", "general-budget", "--stream", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status===0 && j.object==="chat.completion"; } });
test({ id: "H3", desc: "--stream + show-analysis", bin: "harness", tty: true, scenario: { writer: { stream: true } }, args: ["q", "--local", "--preset", "general-budget", "--stream", "--show-analysis"],
  check: (r) => r.status === 0 && inc(r.stdout, "Judge analysis") });
test({ id: "H4", desc: "--stream, gateway can't stream -> full render", bin: "harness", scenario: { writer: { stream: false } }, tty: true, args: ["q", "--local", "--preset", "general-budget", "--stream"],
  check: (r) => r.status === 0 && inc(r.stdout, "FINAL ANSWER") && (r.stdout.match(/FINAL ANSWER/g) || []).length === 1 });

// ----- I. logging -----
const LOGP = join(OUT, "run-log.json");
test({ id: "I1", desc: "--log writes JSON record, exit 0", bin: "harness", args: ["q", "--local", "--preset", "general-budget", "--format", "json", "--log", LOGP],
  setup: () => { if (existsSync(LOGP)) rmSync(LOGP); },
  check: (r) => { if (r.status !== 0 || !existsSync(LOGP)) return false; const rec = JSON.parse(readFileSync(LOGP, "utf8")); return rec.preset === "general-budget" && rec.object === "chat.completion" && typeof rec.logged_at === "string"; } });
test({ id: "I2", desc: "--log bad path warns, run still exits 0", bin: "harness", args: ["q", "--local", "--preset", "general-budget", "--format", "json", "--log", "/no/such/dir/x.json"],
  check: (r) => r.status === 0 && inc(r.stderr, "could not write log") });
const JSONL_I4 = join(OUT, "i4.jsonl");
test({ id: "I4", desc: "repeated --log accumulates as JSONL (spec §16)", bin: "harness",
  args: ["second q", "--local", "--preset", "general-budget", "--format", "json", "--log", JSONL_I4],
  setup: () => { if (existsSync(JSONL_I4)) rmSync(JSONL_I4); run({ bin: "harness", scenario: {}, args: ["first q", "--local", "--preset", "general-budget", "--format", "json", "--log", JSONL_I4] }); },
  check: (r) => { if (r.status !== 0 || !existsSync(JSONL_I4)) return false; const lines = readFileSync(JSONL_I4, "utf8").trim().split("\n").filter(Boolean); return lines.length === 2 && lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }); } });

// ----- J. cost / max-cost -----
const PRICES = { "anthropic/claude-haiku-4.5": { prompt: 0.000001, completion: 0.000002 }, "openai/gpt-5-mini": { prompt: 0.0000005, completion: 0.0000015 }, "google/gemini-2.5-flash": { prompt: 0.0000003, completion: 0.0000009 } };
test({ id: "J3", desc: "--max-cost above estimate proceeds", bin: "harness", scenario: { prices: PRICES }, args: ["q", "--local", "--preset", "general-budget", "--max-cost", "100", "--format", "json"],
  check: (r) => r.status === 0 && inc(r.stderr, "estimated cost") });
test({ id: "J4", desc: "--max-cost below estimate aborts exit 1", bin: "harness", scenario: { prices: PRICES }, args: ["q", "--local", "--preset", "general-budget", "--max-cost", "0.0000001"],
  check: (r) => r.status === 1 && inc(r.stderr, "Aborting") });
test({ id: "J5", desc: "--max-cost prices unavailable warns, proceeds", bin: "harness", scenario: { prices: null }, args: ["q", "--local", "--preset", "general-budget", "--max-cost", "5", "--format", "json"],
  check: (r) => r.status === 0 && inc(r.stderr, "estimate unavailable") });
test({ id: "J5b", desc: "--max-cost price-unknown (empty table) warns, proceeds", bin: "harness", scenario: {}, args: ["q", "--local", "--preset", "general-budget", "--max-cost", "5", "--format", "json"],
  check: (r) => r.status === 0 && inc(r.stderr, "price unknown") });
test({ id: "J6-zero", desc: "--max-cost 0 -> exit 2", bin: "cli", args: ["q", "--local", "--max-cost", "0"],
  check: (r) => r.status === 2 && inc(r.stderr, "invalid --max-cost") });
test({ id: "J6-neg", desc: "--max-cost -1 rejected (exit 2)", bin: "cli", args: ["q", "--local", "--max-cost=-1"],
  check: (r) => r.status === 2 && inc(r.stderr, "invalid --max-cost") });
test({ id: "J6-neg-space", desc: "--max-cost -1 (space form) rejected exit 2", bin: "cli", args: ["q", "--local", "--max-cost", "-1"],
  check: (r) => r.status === 2 });
test({ id: "J7", desc: "cost backfill via /generation", bin: "harness", scenario: { noCost: true, backfill: { "gen-writer": 0.9 } }, tty: true, args: ["q", "--local", "--preset", "general-budget"],
  check: (r) => r.status === 0 && inc(r.stdout, "cost: $0.9000") });
test({ id: "K5", desc: "panel JSON without answer key -> raw content as answer", bin: "harness", scenario: { panel: { default: { mode: "raw", content: "{\"foo\":\"bar\"}" } } }, args: ["q", "--local", "--preset", "general-budget", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status===0 && j.fusionix.panel[0].answer.includes("foo"); } });
test({ id: "MTC", desc: "--max-tool-calls 5 accepted, enforced=false", bin: "harness", args: ["q", "--local", "--preset", "general-budget", "--max-tool-calls", "5", "--format", "json"],
  check: (r) => r.status === 0 && JSON.parse(r.stdout).fusionix.max_tool_calls_enforced === false });
test({ id: "MTC-bad", desc: "--max-tool-calls 0 -> exit 2", bin: "cli", args: ["q", "--local", "--max-tool-calls", "0"],
  check: (r) => r.status === 2 && inc(r.stderr, "max-tool-calls") });
test({ id: "J6-nan", desc: "--max-cost abc -> exit 2", bin: "cli", args: ["q", "--local", "--max-cost", "abc"],
  check: (r) => r.status === 2 && inc(r.stderr, "invalid --max-cost") });
test({ id: "J2", desc: "no cost -> footer n/a", bin: "harness", tty: true, scenario: { noCost: true }, args: ["q", "--local", "--preset", "general-budget"],
  check: (r) => r.status === 0 && inc(r.stdout, "cost: n/a") });

// ----- K. pipeline failure states -----
test({ id: "K2", desc: "1 panel member fails -> continues", bin: "harness", scenario: { panel: { models: { "openai/gpt-5-mini": { mode: "throw" } } } }, args: ["q", "--local", "--preset", "general-budget", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); const failed = j.fusionix.panel.find(p=>p.model==="openai/gpt-5-mini"); return r.status===0 && failed.error && !failed.answer && j.choices[0].message.content.length>0; } });
test({ id: "K3", desc: "all panel fail -> exit 1 all_panel_failed", bin: "harness", scenario: { panel: { default: { mode: "throw" } } }, args: ["q", "--local", "--preset", "general-budget"],
  check: (r) => r.status === 1 && /panel/i.test(r.stderr) });
test({ id: "K4", desc: "panel non-JSON -> raw text answer", bin: "harness", scenario: { panel: { default: { mode: "text" } } }, args: ["q", "--local", "--preset", "general-budget", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status===0 && j.fusionix.panel[0].answer.includes("Plain prose"); } });
test({ id: "K6", desc: "panel empty body -> member failure", bin: "harness", scenario: { panel: { models: { "openai/gpt-5-mini": { mode: "empty" } } } }, args: ["q", "--local", "--preset", "general-budget", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); const m = j.fusionix.panel.find(p=>p.model==="openai/gpt-5-mini"); return r.status===0 && m.error && !m.answer; } });
test({ id: "K7", desc: "judge invalid then repair OK", bin: "harness", scenario: { judge: { first: { mode: "text" }, repair: { mode: "json" } } }, args: ["q", "--local", "--preset", "general-budget", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status===0 && j.fusionix.analysis.consensus.length>=1; } });
test({ id: "K8", desc: "judge invalid twice -> judge_failed exit 1", bin: "harness", scenario: { judge: { first: { mode: "text" }, repair: { mode: "text" } } }, args: ["q", "--local", "--preset", "general-budget"],
  check: (r) => r.status === 1 && /judge/i.test(r.stderr) });
test({ id: "K9", desc: "judge throws -> judge_failed exit 1", bin: "harness", scenario: { judge: { first: { mode: "throw" } } }, args: ["q", "--local", "--preset", "general-budget"],
  check: (r) => r.status === 1 && /judge/i.test(r.stderr) });
test({ id: "K10", desc: "writer empty -> writer_failed exit 1", bin: "harness", scenario: { writer: { mode: "empty" } }, args: ["q", "--local", "--preset", "general-budget"],
  check: (r) => r.status === 1 && /writer/i.test(r.stderr) });
test({ id: "K11", desc: "writer throws -> writer_failed exit 1", bin: "harness", scenario: { writer: { mode: "throw" } }, args: ["q", "--local", "--preset", "general-budget"],
  check: (r) => r.status === 1 && /writer/i.test(r.stderr) });
test({ id: "K12", desc: "panel order preserved", bin: "harness", scenario: {}, args: ["q", "--local", "--panel", "z-first,a-second,m-third", "--judge", "j", "--format", "json"],
  check: (r) => JSON.parse(r.stdout).fusionix.panel.map(p=>p.model).join(",") === "z-first,a-second,m-third" });

// ----- L. config resolution -----
test({ id: "L4", desc: "custom preset via FUSIONIX_CONFIG (legal-risk)", bin: "harness", env: { FUSIONIX_CONFIG: join(ROOT, "qa/fixtures/ext.config.json") }, args: ["q", "--local", "--preset", "legal-risk", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status===0 && j.fusionix.panel.length===3; } });
test({ id: "L2", desc: "FUSIONIX_CONFIG missing path -> error nonzero", bin: "harness", env: { FUSIONIX_CONFIG: join(ROOT, "qa/fixtures/does-not-exist.json") }, args: ["q", "--local", "--preset", "general-budget"],
  check: (r) => r.status !== 0 });
test({ id: "L3", desc: "FUSIONIX_DEFAULT_GATEWAY env override (no crash)", bin: "harness", env: { FUSIONIX_DEFAULT_GATEWAY: "https://gw.example/api/v1" }, args: ["q", "--local", "--preset", "general-budget", "--format", "json"],
  check: (r) => r.status === 0 });

// ----- N. v0.9 Fugu extensions (§22) -----
test({ id: "N1", desc: "§22.1 --only-provider filters the panel", bin: "harness", args: ["q", "--local", "--only-provider", "openai,google", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status===0 && j.fusionix.panel.length===2 && j.fusionix.panel.every((p)=>/^(openai|google)\//.test(p.model)); } });
test({ id: "N2", desc: "§22.1 --exclude-provider drops a provider", bin: "harness", args: ["q", "--local", "--exclude-provider", "anthropic", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status===0 && j.fusionix.panel.every((p)=>!p.model.startsWith("anthropic/")); } });
test({ id: "EC-N2a", desc: "§22.1 filtering that empties the panel -> error nonzero", bin: "harness", args: ["q", "--local", "--exclude-provider", "anthropic,openai,google"],
  check: (r) => r.status !== 0 });
test({ id: "N3", desc: "§22.4 --route runs a single best-fit model (math->openai)", bin: "harness", args: ["Prove the theorem about polynomial roots", "--local", "--route", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status===0 && j.fusionix.panel===undefined && j.fusionix.route_category==="math" && j.fusionix.model_used==="openai/gpt-5.2"; } });
test({ id: "N4", desc: "§22.3 --mode fast is sugar for routing", bin: "harness", args: ["Explain the chemistry of this enzyme reaction", "--local", "--mode", "fast", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status===0 && j.fusionix.route_category==="science" && j.fusionix.model_used==="google/gemini-3.1-pro-preview"; } });
test({ id: "N5", desc: "§22.2 --writer-strategy capability switches the writer to the math specialist (research-high writer is Opus)", bin: "harness", args: ["Prove the theorem about polynomial roots", "--local", "--preset", "research-high", "--writer-strategy", "capability", "--format", "md"],
  check: (r) => r.status === 0 && /writer: openai\/gpt-5\.2/.test(r.stdout) });
test({ id: "N6", desc: "§22.5 --topology debate revises panel answers before judge", bin: "harness", args: ["q", "--local", "--topology", "debate", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status===0 && j.fusionix.panel.length===3 && j.fusionix.panel.every((p)=>p.answer.startsWith("revised-")); } });
test({ id: "EC-N7a", desc: "§22 invalid --writer-strategy -> exit 2", bin: "cli", args: ["q", "--local", "--writer-strategy", "bogus"],
  check: (r) => r.status === 2 && inc(r.stderr, "writer-strategy") });
test({ id: "EC-N7b", desc: "§22 invalid --topology -> exit 2", bin: "cli", args: ["q", "--local", "--topology", "tree"],
  check: (r) => r.status === 2 && inc(r.stderr, "topology") });
test({ id: "EC-N7c", desc: "§22 invalid --mode -> exit 2", bin: "cli", args: ["q", "--local", "--mode", "turbo"],
  check: (r) => r.status === 2 && inc(r.stderr, "mode") });
test({ id: "N8", desc: "§22 default (no v0.9 flags) is unchanged deliberation", bin: "harness", args: ["q", "--local", "--format", "json"],
  check: (r) => { const j = JSON.parse(r.stdout); return r.status===0 && j.fusionix.panel.length===3 && j.fusionix.route_category===undefined && j.fusionix.analysis!==undefined; } });

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const failures = [];
for (const c of cases) {
  if (c.setup) c.setup();
  let r, ok, err;
  try {
    r = run(c);
    ok = c.check(r);
  } catch (e) {
    ok = false;
    err = e;
  }
  const rec = [
    `CASE ${c.id}: ${c.desc}`,
    `bin=${c.bin} args=${JSON.stringify(c.args)} tty=${!!c.tty} scenario=${JSON.stringify(c.scenario ?? {})}`,
    `exit=${r?.status} spawnError=${r?.error ?? "none"}`,
    `--- stdout ---\n${r?.stdout ?? ""}`,
    `--- stderr ---\n${r?.stderr ?? ""}`,
    err ? `--- check threw ---\n${err.stack ?? err}` : "",
    `RESULT: ${ok ? "PASS" : "FAIL"}`,
  ].join("\n");
  writeFileSync(join(OUT, `${c.id}.log`), rec);
  if (ok) { pass++; }
  else { fail++; failures.push({ id: c.id, desc: c.desc, exit: r?.status, stderr: (r?.stderr||"").slice(0,300), stdout:(r?.stdout||"").slice(0,300) }); }
  process.stdout.write(`${ok ? "✔" : "�’✗"} ${c.id}  ${c.desc}\n`.replace("�’", ""));
}

process.stdout.write(`\n=== ${pass}/${cases.length} passed, ${fail} failed ===\n`);
if (failures.length) {
  process.stdout.write(`\nFAILURES:\n`);
  for (const f of failures) {
    process.stdout.write(`\n[${f.id}] ${f.desc}\n  exit=${f.exit}\n  stderr: ${f.stderr.replace(/\n/g," ")}\n  stdout: ${f.stdout.replace(/\n/g," ")}\n`);
  }
}
process.exit(fail ? 1 : 0);
