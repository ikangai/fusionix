# Fusionix Phase 1 — User-Facing Inventory & Acceptance Criteria

Scope: **Phase 1 only** = `packages/core` (pipeline) + `packages/cli` (local CLI). Phases 2–5
(hosted API, auth, SDK, skill, landing) do not exist yet and are out of scope.

The single user-facing surface is the `fusionix` CLI (`--local` mode) plus the configuration
files and environment variables it reads. There is no GUI, no routes, no roles, no modals, no
buttons — so "routes/buttons/modals/roles" from the goal map onto **CLI flags, input channels,
output states, config inputs, and pipeline workflows**.

Legend: **AC** = acceptance criteria, **EC** = risk-based edge case. Each item has a test ID used
by `qa/drive.mjs` and the bug log.

---

## A. Invocation & meta commands

| ID | Feature | Acceptance criteria |
|----|---------|---------------------|
| A1 | `--help` | Prints usage/help to stdout; exit 0; no gateway call. |
| A2 | `--version` | Prints version + newline to stdout; exit 0. |
| A3 | no prompt, no stdin | stderr "no prompt provided"; exit 2. |
| A4 | unknown flag `--bogus` | stderr parse error; exit 2. |

- EC-A4a: a flag that looks valid but mistyped (`--pannel`) → exit 2, not silently ignored.
- EC-A2a: `--help` and `--version` together → help wins (checked first), exit 0.

## B. Prompt input channels

| ID | Feature | Acceptance criteria |
|----|---------|---------------------|
| B1 | positional prompt | Used verbatim (trimmed) as the user message. |
| B2 | multiple positionals | Joined with single spaces. |
| B3 | piped stdin (no positional) | stdin content (trimmed) used as prompt. |
| B4 | positional **and** stdin | Positional wins; stdin not read/ignored; no hang. |
| B5 | whitespace-only prompt | Treated as empty → "no prompt provided"; exit 2. |
| B6 | production-scale stdin (~50KB) | Deliberation runs to completion; no truncation/crash. |
| B7 | unicode / newlines / shell metachars in prompt | Preserved; no crash. |

- EC-B3a: empty stdin (`echo -n "" |`) with no positional → exit 2.
- EC-B6a: very large prompt does not blow up `--max-cost` estimate (chars/4 projection).

## C. Mode gating (Phase 1)

| ID | Feature | Acceptance criteria |
|----|---------|---------------------|
| C1 | no `--local` | stderr "hosted mode is not available yet (Phase 1)"; exit 2. |
| C2 | `--local`, no `OPENROUTER_API_KEY` | stderr "OPENROUTER_API_KEY is not set"; exit 1. |
| C3 | `--local` + key | Pipeline runs. |
| C4 | `--api-url` with `--local` | stderr warning that it is ignored; run still proceeds. |

- EC-C1a: `--help` works even without `--local` and without a key (meta short-circuits).

## D. Presets

| ID | Feature | Acceptance criteria |
|----|---------|---------------------|
| D1 | each of the 6 bundled presets | Resolves the documented panel/judge/writer/web from config. |
| D2 | default preset (no `--preset`) | `general-high` (config `defaultPreset`). |
| D3 | `--preset bogus` | Error "Unknown preset: bogus"; nonzero exit. |
| D4 | `FUSIONIX_DEFAULT_PRESET=x` | Overrides default preset when `--preset` absent. |
| D5 | `FUSIONIX_DEFAULT_PRESET=missing` | loadConfig fails fast (internal_error); nonzero exit. |

- EC-D1a: `code-review` / `architecture-review` have `web:false` → web "off" without `--no-web`.

## E. Model overrides

| ID | Feature | Acceptance criteria |
|----|---------|---------------------|
| E1 | `--panel a,b,c` | Overrides preset panel; output panel order = a,b,c. |
| E2 | `--judge m` / `--writer m` | Override judge / writer model. |
| E3 | `--panel "a, b ,c,"` | CSV trimmed; empties dropped → [a,b,c]. |
| E4 | `--panel ""` | Empty string → flag ignored (preset panel used). |
| E5 | `--panel " , "` | Resolves to empty list → invalid_request; nonzero exit. |
| E6 | `--writer concrete/model` | Writer = that model; panel/judge from preset/default. |

## F. Web search

| ID | Feature | Acceptance criteria |
|----|---------|---------------------|
| F1 | default (preset web) | Honors preset/config `web`. |
| F2 | `--no-web` | web "off"; base model called (no `:online`). |
| F3 | web on, `:online` succeeds | web "used". |
| F4 | web on, `:online` fails | Falls back to base; web "unsupported"; run still succeeds. |
| F5 | preset `web:false` | web "off" even without `--no-web`. |

## G. Output formats

| ID | Feature | Acceptance criteria |
|----|---------|---------------------|
| G1 | `--format md` | answer + (opt) analysis + footer; trailing newline. |
| G2 | `--format json` | OpenAI-shaped `chat.completion` with `fusionix` extras. |
| G3 | `--format text` | Plain answer + (opt) analysis + footer. |
| G4 | default by TTY | md on TTY, json on pipe. |
| G5 | `--format xml` | stderr invalid format; exit 2. |
| G6 | `--show-analysis` (md/text) | Judge analysis section appended. |
| G7 | `--show-analysis` + json | json already carries analysis; flag has no extra effect, no crash. |

- EC-G2a: json `fusionix.panel` preserves resolved order; failed members carry `error`.
- EC-G2b: `cost_usd` is `null` (not absent) when no gateway cost reported (deliberation mode).

## H. Streaming

| ID | Feature | Acceptance criteria |
|----|---------|---------------------|
| H1 | `--stream` (md/text) | Answer streamed to stdout, then extras (footer / analysis). |
| H2 | `--stream` + json | Streaming suppressed; full json printed once. |
| H3 | `--stream` + `--show-analysis` | Analysis rendered after the streamed answer. |
| H4 | `--stream`, gateway can't stream | Falls back to full render; answer not dropped/duplicated. |

## I. Logging

| ID | Feature | Acceptance criteria |
|----|---------|---------------------|
| I1 | `--log path` | Writes a JSON run record; run exit unaffected. |
| I2 | `--log /bad/path` | stderr warning "could not write log"; run still exits 0. |
| I3 | log record shape | Has `logged_at`, `preset`, and the full chat.completion. |
| I4 | repeated `--log run.jsonl` | Accumulates as JSONL — one valid JSON object per line, per run (§16). Each line carries resolved panel/judge/writer models. |

## J. Cost & `--max-cost`

| ID | Feature | Acceptance criteria |
|----|---------|---------------------|
| J1 | cost from usage | Footer/JSON report summed `cost_usd`. |
| J2 | no cost reported | `cost_usd` null; footer shows "n/a". |
| J3 | `--max-cost` ≥ estimate | stderr note of estimate; run proceeds. |
| J4 | `--max-cost` < estimate | stderr "exceeds --max-cost … Aborting."; exit 1; no model calls. |
| J5 | `--max-cost`, prices unavailable | stderr "price unknown … Proceeding."; run proceeds. |
| J6 | `--max-cost 0` / `-1` / `abc` | stderr invalid; exit 2. |
| J7 | cost backfill | Streamed/missing-cost call backfilled via `/generation`. |

## K. Pipeline behavior (workflows & failure states)

| ID | Feature | Acceptance criteria |
|----|---------|---------------------|
| K1 | happy path | panel→judge→writer; answer + analysis + panel returned. |
| K2 | 1 panel member fails | Run continues; failed member shown "(failed)" / `error` in JSON. |
| K3 | all panel members fail | `all_panel_failed`; exit 1. |
| K4 | panel returns non-JSON | Raw text kept as `answer`; no repair call. |
| K5 | panel JSON without `answer` key | Raw content used as answer; no crash. |
| K6 | panel empty body | Treated as member failure. |
| K7 | judge invalid → repair OK | Run succeeds. |
| K8 | judge invalid twice | `judge_failed`; exit 1. |
| K9 | judge throws | `judge_failed`; exit 1. |
| K10 | writer empty | `writer_failed`; exit 1. |
| K11 | writer throws | `writer_failed`; exit 1. |
| K12 | panel order | Output panel order == resolved order regardless of completion order. |

## L. Configuration resolution

| ID | Feature | Acceptance criteria |
|----|---------|---------------------|
| L1 | auto-discover `./fusionix.config.json` | Deep-merges over bundled defaults. |
| L2 | `FUSIONIX_CONFIG=path` | Explicit path loaded; missing path → error. |
| L3 | `FUSIONIX_DEFAULT_GATEWAY` / `_PRESET` | Env wins last. |
| L4 | custom preset via external config | Usable by name (e.g. `legal-risk`). |

## M. JSON wire shape (§6.3) — consumed by `--format json` and SDK/API later

| ID | Feature | Acceptance criteria |
|----|---------|---------------------|
| M1 | `choices[0].message.content` | == final answer. |
| M2 | `fusionix.panel[]` | resolved order; failed members `{model,error}`. |
| M3 | `fusionix.analysis` | snake_case keys (partial_coverage, unique_insights, blind_spots). |
| M4 | bypass extras (core only) | only `run_id`, `duration_ms`, `web` (no CLI flag exposes bypass). |

---

## Notes on coverage boundaries

- **Single-model bypass (§6.7)** is a core feature but **not reachable from the CLI** — no flag
  sets `plugins[].enabled=false`. Tested at the core level only; flagged as a CLI gap (not a bug).
- **Live network** (real OpenRouter calls) is intentionally NOT exercised in the automated matrix:
  it costs money and hits an external service. The harness (`qa/run.ts`) reproduces production-like
  model behavior offline. A live smoke run requires explicit operator approval.
