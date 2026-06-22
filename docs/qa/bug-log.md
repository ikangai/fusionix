# Fusionix Phase 1 — QA Bug Log

Campaign: full user-facing QA pass on Phase 1 (core + local CLI). Method: real-user testing via
`qa/drive.mjs` (genuine bin + harness driving the real pipeline through a fake gateway), plus a
first-principles + 3-agent adversarial code review. Baseline before campaign: 176 unit tests green,
`tsc -b` clean, Node 25.1.

Severity: **P1** crash/data-loss · **P2** wrong result / spec violation · **P3** minor/cosmetic/robustness.
Status: OPEN → FIXED (with regression test) / WONTFIX (with rationale) / OBSERVATION (not a defect).

## Resolution summary

5 confirmed defects, all **FIXED** with regression tests (TDD: red → green). Final state: **188/188 unit
tests green**, `tsc -b` clean, **78/78 QA inventory (`qa/drive.mjs`) green**, all fixes re-verified end-to-end
through the real CLI.

| ID | Severity | Area | Fix | Regression test |
|----|----------|------|-----|-----------------|
| BUG-4 | P2 (→P1 on judge) | `core/json.ts` | earliest-first multi-candidate scan | `core/test/json.test.ts` (+6) |
| BUG-1 | P2 | `cli/main.ts` | JSONL append (was overwrite) | `cli/test/main.test.ts` + driver I4 |
| C1 | P2 | `cli/main.ts` (+`core` result) | log resolved panel/judge/writer (§16) | `cli/test/main.test.ts` |
| BUG-2 | P3 | `core/pipeline/web-call.ts` | rethrow on aborted signal | `core/test/web-call.test.ts` |
| BUG-3 | P3 | `cli/format.ts` | omit empty analysis section | `cli/test/format.test.ts` (+4) |
| C4 | P3 | `cli/main.ts` | single config load (reuse) | `cli/test/main.test.ts` |

Shared-cause note: **BUG-4** (`json.ts`) is the cross-cutting root cause — shared by both panel (`panel.ts`)
and judge (`judge.ts`) parsing, so one fix hardens both stages and removes spurious judge repair/`judge_failed`.
**BUG-1 + C1 + C4** all live in the `--log`/config path of `main.ts` and were fixed as one coherent change.

---

## BUG-1 — `--log` overwrites the file; repeated runs lose history (spec §16 says "JSONL")

- **Severity:** P2 · **Status:** FIXED
- **Where:** `packages/cli/src/main.ts:228-241` (`writeFile` truncates).
- **Spec:** §16 — *"Optional full JSONL run log for the local CLI: `fusionix "question" --local --log run.jsonl`"*. The `.jsonl` filename and the term **JSONL** (line-delimited JSON) imply each run **appends** one record. (Help/README say "a JSON run record", which is the looser, overwrite-consistent wording — an internal doc inconsistency too.)
- **Repro (evidence):** `qa/out/jsonl-probe` run twice to the same `--log` path →
  ```
  run 1: fusionix "first question"  --local --log run.jsonl
  run 2: fusionix "second question" --local --log run.jsonl
  wc -l run.jsonl  → 1     (expected 2)
  cat run.jsonl    → only the SECOND run's record; first run lost.
  ```
- **Expected:** repeated runs accumulate as JSONL (one valid JSON object per line); a single run still yields a one-line file.
- **Actual:** file truncated each run; only the last run survives.
- **Fix direction:** append with a trailing newline (true JSONL); reconcile help/README wording to "Append a JSON run record (JSONL)".
- **Regression test:** `qa/drive.mjs` case **I4** (runs twice, asserts 2 valid JSONL lines) — currently RED; + a CLI unit test in `packages/cli/test`.

## BUG-2 — `chatWithWebFallback` treats an aborted signal as "web unsupported" and makes a wasted second call

- **Severity:** P3 (robustness + abort semantics) · **Status:** FIXED
- **Where:** `packages/core/src/pipeline/web-call.ts:42-49`.
- **Spec:** §15/§17 — web fallback is for *web variant unsupported*, not for deadline/cancellation. On `maxRequestDurationMs` or caller abort, outstanding calls should abort, not silently retry.
- **Repro (evidence):** direct call with a pre-aborted signal (`qa/repro-webfallback.ts`, since removed):
  ```
  chatWithWebFallback(gw, "modelX", msgs, { web:true, signal: <aborted> })
  → gateway.chat called TWICE: ["modelX:online","modelX"]   (expected: 1 call, then rethrow)
  ```
- **Expected:** when `opts.signal?.aborted`, rethrow the abort instead of issuing the no-web retry.
- **Actual:** the bare `catch` swallows the AbortError and re-calls with the same dead signal — a wasted round-trip per in-flight web call on every deadline/cancel; with a signal-ignoring gateway it could mis-report `web:"unsupported"` for what was actually a timeout.
- **Fix direction:** in the `catch (err)`, `if (opts.signal?.aborted) throw err;` before the retry.
- **Regression test:** core unit test in `packages/core/test/web-call.test.ts` asserting a single call + rethrow under an aborted signal.

## BUG-3 — `--show-analysis` renders an empty `## Judge analysis` header when the analysis is all-empty

- **Severity:** P3 (cosmetic) · **Status:** FIXED
- **Where:** `packages/cli/src/format.ts:22-42` (`renderAnalysisMarkdown` / `renderAnalysisText`).
- **Repro (evidence):** judge returns `{}` (valid empty analysis), run with `--show-analysis`:
  ```
  FINAL ANSWER: ...

  ## Judge analysis      <- bare heading, no content

  ---
  _panel: ... _
  ```
- **Expected:** when every analysis section is empty, omit the heading (or print "No analysis available.") rather than a dangling header.
- **Actual:** a content-free `## Judge analysis` heading (md) / `Judge analysis:` line (text).
- **Fix direction:** if all six arrays are empty, return "" (or a single explanatory line) so the renderer skips the section.
- **Regression test:** `packages/cli/test/format.test.ts` — empty analysis + showAnalysis → no dangling heading.

## BUG-4 — `extractJson` only tries the earliest `{`/`[`; valid JSON after brace-y prose is dropped

- **Severity:** P2 (wrong result; escalates to P1 `502 judge_failed` on the judge path) · **Status:** FIXED
- **Where:** `packages/core/src/json.ts:60-78` (`firstCandidate`) + `extractJson:96-101`.
- **Spec:** §14.1 wants lenient extraction so prose-wrapped JSON parses; §14.2 only triggers the judge repair / `judge_failed` when extraction *genuinely* fails. Shared by **panel** (`panel.ts:55`) and **judge** (`judge.ts:36`) — a single root cause affecting both stages.
- **Repro (evidence, `qa/repro-json.ts`):** every case returns `undefined`:
  ```
  'The function `f() { return x; }` has a bug.\n\n{"answer":"fix"}'   => UNDEFINED
  'The set {1,2,3} is finite.\n{"answer":"ok"}'                       => UNDEFINED
  'Use the {placeholder} token: {"answer":"ok"}'                      => UNDEFINED
  'see {not json} but {"a":1}'                                        => UNDEFINED
  '```json\n{"answer":"clean"}\n```'                                  => {"answer":"clean"}  (fence path OK)
  ```
- **Why it matters:** the `code-review` / `architecture-review` presets (the product's flagship differentiators, §5/§12) have panelists that routinely emit code/set-notation containing `{` *before* their JSON. Panel degrades to raw-text answer (tolerable §14.1); the **judge** is forced into a repair call and, if it also leads with brace-y prose, ends in `502 judge_failed`.
- **Expected:** extract the valid trailing JSON object/array.
- **Actual:** `firstCandidate` returns the first *balanced* span (`{ return x; }`, `{1,2,3}`, `{not json}`); `tryParse` fails; `extractJson` returns `undefined` without trying the next opener.
- **Fix direction:** when a candidate span fails to parse, advance to the next `{`/`[` after the previous opener and retry until one parses or the string is exhausted (keep the scan linear — no regex backtracking).
- **Regression test:** `packages/core/test/json.test.ts` — the four cases above must extract; plus a long-input perf guard.

## C1 — `--log` run record omits the resolved judge & writer models (§16)

- **Severity:** P2 · **Status:** FIXED (bundled with BUG-1)
- **Where:** `packages/cli/src/main.ts` log record (was `{logged_at, preset, ...toChatCompletion}` — `toChatCompletion` hardcodes top-level `model:"fusionix"`; extras only carry `panel[].model`).
- **Spec:** §16 — the run log must contain "panel models, **judge model, writer model**". The judge/writer slugs appeared nowhere.
- **Fix:** added resolved `judge` to `FusionixRunResult` (`core/types.ts` + `core/pipeline/run.ts`) and a `models: { panel, judge, writer }` block to the log record.
- **Evidence:** two JSONL lines now each carry `panel=[...] judge=openai/gpt-5-mini writer=openai/gpt-5-mini`.
- **Regression test:** `packages/cli/test/main.test.ts` (C1).

## C4 — config loaded twice on the `--max-cost` path (latent TOCTOU)

- **Severity:** P3 · **Status:** FIXED
- **Where:** `packages/cli/src/main.ts` — `checkMaxCost` loaded config, then `runFusionix` loaded it again (`main` never passed `opts.config`). A config edited between the two loads would make the estimated plan diverge from the executed plan. (Invisible to the QA harness, which injects one shared config — flagged by the review agent.)
- **Fix:** `checkMaxCost` returns the config it loaded; `main` reuses it via `runOpts.config`.
- **Regression test:** `packages/cli/test/main.test.ts` (C4 — asserts `opts.config` is the same object).

---

## Observations (not defects)

- **OBS-1 — `--max-cost -1` (space form):** Node `parseArgs` rejects the dash-prefixed value with its own
  "argument is ambiguous … use `--max-cost=-XYZ`" message and exit 2. The value is still rejected (and
  `--max-cost=-1` hits our own "invalid --max-cost" message). Acceptance (exit ≠ 0 on a negative cap) is met.
  Common to all `parseArgs`-based CLIs; not a Fusionix defect.
- **OBS-2 — single-model bypass (§6.7) not reachable from the CLI:** no flag sets `plugins[].enabled=false`.
  This is a CLI surface gap, consistent with the §10.2 option list (which has no bypass flag); the behavior
  exists and is correct in core. Not a defect for Phase 1.
- **OBS-3 — streaming-bypass + web has no fallback** (`run.ts:197-204`): a web-routing failure surfaces as
  `writer_failed` instead of `web:"unsupported"` (§15). Documented as intentional ("no fallback while
  streaming") and unreachable from the CLI (bypass has no flag). Tracked; deferred unless bypass is exposed.

- **OBS-4 — Fusionix trigger uses `plugins.filter(id==="fusionix")` (any index), not literal `plugins[0]`**
  (`normalize.ts:40,50`): spec §6.8 says *"`plugins[0].id === "fusionix"`"*. The filter approach is more
  robust (it also enforces the ">1 fusionix plugin" rejection, which strict `[0]` literalism would miss) and
  the CLI always emits a single first-position fusionix plugin. Treated as a defensible deviation, not a defect.
- **Verified clean (agent A):** prototype-pollution defense in config (`__proto__`/`constructor`/`prototype`
  reserved in both merge paths), deep-merge precedence, normalize precedence (§6.8 step 4), validation reject
  paths (§6.8 step 6), purity/idempotency of `foldRoles`/`normalizeRequest`/`prependSystem`, `contentToString`
  / `renderCompactPrompt` (§14.0, caller system preserved), `stripFence` linearity.
- **Verified clean (pipeline agent):** cost aggregation (no double-count), AbortSignal lifecycle in `run.ts`,
  judge one-repair + temp-0 + deadline mapping (§14.2/§17), `all_panel_failed`/`judge_failed`/`writer_failed`
  boundary, bypass extras shape (§6.7), empty-body member handling.

- **OBS-5 — streaming answer emitted untrimmed** (`main.ts` stream path vs `format.ts` `.trim()`): the
  non-streaming render trims leading/trailing whitespace; the streaming path emits raw deltas. Identical
  content, cosmetic whitespace difference only. Inherent to token streaming (trimming the first delta requires
  buffering, defeating streaming). Accepted.
- **OBS-6 — `fusionix` wire-object key order** (`result-wire.ts`): `--format json` emits keys as
  `run_id, cost_usd, duration_ms, web, max_tool_calls_enforced, panel, analysis`; §6.3's example shows
  `run_id, panel, analysis, cost_usd, …`. JSON key order is not normative or OpenAI-compatibility-significant;
  the panel **array** order (resolved order, failures in place) is correct. Cosmetic; not fixed.
- **OBS-7 — `MAX_SSE_LINE_CHARS` checks the buffer, not a single line** (`gateway/openrouter.ts`): misnamed,
  but only false-positives above 8 MB in a single `read()` — not a realistic defect. SSE parser otherwise
  verified clean (CRLF, UTF-8 multibyte split across reads, `[DONE]`, usage-only final chunk, no-newline tail).

## Status: COMPLETE — clean pass
All 5 confirmed defects fixed with regression tests; 188/188 unit tests green; `tsc -b` clean; 78/78 QA
inventory green; fixes re-verified end-to-end. No live-network (paid) runs were made — a live OpenRouter
smoke test remains available pending operator approval (cost + external service).
