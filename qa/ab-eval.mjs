#!/usr/bin/env node
/**
 * A/B evaluation harness (v0.9 §22) — deliberation vs. the single best panelist.
 *
 * The Sakana Fugu report's central claim is that an orchestrated collective reaches
 * "performance beyond any individual LLM agent." This harness makes that claim
 * INSPECTABLE for fusionix: it runs the same prompt as (A) full panel→judge→writer
 * deliberation and (B) a single routed model, and contrasts the outputs.
 *
 * OFFLINE by default: it drives the real CLI + real pipeline through the fake gateway
 * (qa/run.ts), so it spends no money and asserts only STRUCTURAL properties — the
 * synthesized answer is distinct from any one panelist's answer, and routing collapses
 * to a single model. A genuine *quality* A/B requires a live gateway (operator-gated);
 * point this at one by replacing the scenario plumbing with real --local runs.
 *
 * Run: node qa/ab-eval.mjs   (exits non-zero if a structural invariant breaks)
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GPT = "openai/gpt-5.2";
const OPUS = "anthropic/claude-opus-4.8";
const GEMINI = "google/gemini-3.1-pro-preview";
const PROMPT = "Compare SQLite and Postgres for an agent coordination store.";

function harness(args, scenario) {
  const r = spawnSync("node", ["--conditions=development", join(ROOT, "qa/run.ts"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, OPENROUTER_API_KEY: "sk-test", QA_SCENARIO: JSON.stringify(scenario ?? {}) },
  });
  if (r.status !== 0) {
    process.stderr.write(`ab-eval: harness exited ${r.status}\n${r.stderr}\n`);
    process.exit(2);
  }
  return JSON.parse(r.stdout);
}

// Minimal mirror of src/pipeline/aggregator.ts resolveRankedModel.
function resolveRanked(entry, models) {
  const lower = String(entry).trim().toLowerCase();
  const exact = models.find((m) => m.toLowerCase() === lower);
  if (exact) return exact;
  const idx = lower.match(/^\[?(\d+)\]?$/);
  if (idx) {
    const k = Number(idx[1]);
    return k >= 1 && k <= models.length ? models[k - 1] : undefined;
  }
  return models.find((m) => m.toLowerCase().includes(lower) || lower.includes(m.toLowerCase()));
}

function snippet(s, n = 60) {
  return (s ?? "").replace(/\s+/g, " ").slice(0, n);
}

// (A) Full deliberation. The judge ranks GPT best so we can name "the single best panelist".
const delib = harness([PROMPT, "--local", "--format", "json"], { judge: { ranking: [GPT, OPUS, GEMINI] } });
const panel = delib.fusionix.panel;
const ranking = delib.fusionix.analysis.ranking;
const bestModel = resolveRanked(ranking[0], panel.map((p) => p.model));
const bestAnswer = panel.find((p) => p.model === bestModel)?.answer ?? "";
const finalAnswer = delib.choices[0].message.content;

// (B) Route the same prompt to a single best-fit model.
const routed = harness([PROMPT, "--local", "--route", "--format", "json"], {});
const routedModel = routed.fusionix.model_used;
const routedAnswer = routed.choices[0].message.content;

console.log("A/B evaluation — deliberation vs. single model (offline, structural)\n");
console.log(`Prompt: ${PROMPT}\n`);
console.log("(A) Deliberation");
console.log(`  panel:           ${panel.map((p) => p.model).join(", ")}`);
console.log(`  judge ranking:   ${ranking.join(" > ")}`);
console.log(`  best panelist:   ${bestModel} → "${snippet(bestAnswer)}"`);
console.log(`  synthesized:     "${snippet(finalAnswer)}"\n`);
console.log("(B) Routed single model");
console.log(`  category→model:  ${routed.fusionix.route_category} → ${routedModel}`);
console.log(`  answer:          "${snippet(routedAnswer)}"\n`);

// Structural invariants (the offline guarantees this harness can actually check).
const checks = [
  ["deliberation synthesizes (final answer ≠ best panelist's raw answer)", finalAnswer.trim() !== bestAnswer.trim()],
  ["deliberation queried the whole panel", panel.length >= 2],
  ["routing collapsed to a single model", typeof routedModel === "string" && routedModel.length > 0],
  ["routing reports no panel (single-model run)", routed.fusionix.panel === undefined],
];
let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? "✔" : "✗"} ${label}`);
  if (!pass) ok = false;
}
console.log(`\n=== ${ok ? "PASS" : "FAIL"} ===`);
process.exit(ok ? 0 : 1);
