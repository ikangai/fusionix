# Fusionix Phase 1 (Core + Local CLI) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each task. Commit after each green task.

**Goal:** Build the Fusionix core deliberation pipeline (panel → judge → writer) and a local CLI so that `fusionix "hard question" --local --preset general-high` runs the pipeline against OpenRouter and returns one synthesized answer with `cost_usd`, panel in resolved order, caller system messages preserved, and the §14 parse-failure rules.

**Architecture:** TypeScript ESM monorepo (npm workspaces). `packages/core` is pure logic (no web/CLI/UI): request normalization (§6.8), message handling (§14.0), preset expansion, an OpenRouter gateway client, the three pipeline stages, cost aggregation, timeout/cancellation, and result shaping. `packages/cli` is a thin wrapper that, with `--local`, calls core directly using `OPENROUTER_API_KEY`. Model slugs live in `packages/core/config/default.config.json` (data), never in core logic.

**Tech Stack:** Node 25 (native TS type-stripping for dev/test, global `fetch`, `util.parseArgs`, `node:test`). Zero external runtime/test dependencies. `typescript` is the only dev dependency (builds + typecheck via `tsc -b`). Tests run with `node --conditions=development --test`.

**Scope discipline:** Phase 1 ONLY. No hosted API, auth, key storage, SDK, skill, or landing page (§18). No debate rounds, critic judge, custom web loop, or panel-JSON repair (§14.1, §19). `max_tool_calls` is advisory (§15). Single-model bypass (§6.7) IS in scope (core).

---

## Conventions

- **TDD:** write failing test → run (red) → minimal impl → run (green) → commit.
- **Run a single test file:** `node --conditions=development --test packages/core/test/<file>.test.ts`
- **Run all:** `npm test`
- **Typecheck/build:** `npm run build`
- **Erasable-only TS:** no `enum`, no `namespace`, no constructor parameter-properties (enforced by `erasableSyntaxOnly`). Use `const` objects + union string types.
- **Determinism:** core takes an injectable `fetch` and (where needed) `now()`/`randomId()` so the gateway can be mocked in tests with no network.

---

## Module map (packages/core/src)

```
index.ts        public API: runFusionix(request, opts) + type re-exports
types.ts        wire + internal types (FusionixChatCompletionRequest, PanelResponse, FusionixAnalysis, ExecutionPlan, GatewayCall, ...)
errors.ts       FusionixError (code, httpStatus) + code constants
json.ts         extractJson(text): lenient JSON extraction (fences, first balanced object)
config.ts       loadConfig(opts): default config + file/env overrides; redactPreset()
normalize.ts    normalizeRequest(request, config): ExecutionPlan + validation (§6.8)
messages.ts     message helpers: foldRoles, findLastUserMessage, renderCompactPrompt, buildPanelMessages
prompts.ts      PANEL/JUDGE/WRITER system text (§14) + renderJudgeUser/renderWriterUser
gateway/openrouter.ts  OpenRouterGateway: chat(), listModels(), getGeneration(); attribution headers; error mapping
gateway/web.ts  applyWeb(model, web): ":online" suffix mechanism + reporting
cost.ts         aggregateUsage(calls): {usage, costUsd|null}
pipeline/panel.ts   runPanel(plan, messages, deps) → PanelResponse[] (resolved order, failures in place)
pipeline/judge.ts   runJudge(plan, prompt, panel, deps) → FusionixAnalysis (one repair attempt)
pipeline/writer.ts  runWriter(plan, prompt, analysis, deps) → {answer, call}
pipeline/run.ts     orchestrate: bypass | panel→judge→writer; deadline; cost; shape FusionixRunResult
util.ts         withTimeout/deadline helpers, defaultRandomId
```

---

## Task 0 — Scaffold (DONE)

Monorepo root (`package.json`, `tsconfig.base.json`, `tsconfig.json`), `packages/core` and `packages/cli` manifests + tsconfigs, `packages/core/config/default.config.json` with **live-verified slugs (2026-06-18)** and the 6 presets, `.gitignore`. `npm install` done; workspace symlinks + tsc verified. Commit scaffold first.

---

## Task 1 — Errors + types

**Files:** Create `packages/core/src/errors.ts`, `packages/core/src/types.ts`; Test `packages/core/test/errors.test.ts`.

`errors.ts`: `FUSIONIX_ERROR_CODES` const map → HTTP status (per §6.6). `class FusionixError extends Error { code; httpStatus; runId?; details? }`. Helper `isFusionixError`.

Codes/status: `invalid_request`=400, `not_a_fusionix_request`=400, `unauthorized`=401, `prompt_too_large`=413, `limit_exceeded`=429, `all_panel_failed`=502, `judge_failed`=502, `writer_failed`=502, `gateway_error`=502, `internal_error`=500.

`types.ts`: wire types (`ChatMessage`, `FusionixPlugin`, `FusionixChatCompletionRequest`), result types (`PanelResponse`, `FusionixAnalysis`, `Usage`, `FusionixExtras`, `FusionixRunResult`), internal (`ResolvedPreset`, `ExecutionPlan`, `GatewayCallResult`, `FusionixConfig`).

**Tests:** `new FusionixError("all_panel_failed").httpStatus === 502`; codes map present; `isFusionixError` true/false.

**Commit:** `feat(core): error types and core type definitions`

---

## Task 2 — Lenient JSON extraction (`json.ts`)

Panel/judge return JSON in prose sometimes. `extractJson(text): unknown | undefined`:
1. `JSON.parse(text)` whole.
2. Strip ```json / ``` fences, retry.
3. Scan for first balanced `{...}` (string/escape aware) and parse.
4. else `undefined`.

**Tests:** plain object; fenced ```json; object with prose around it; nested braces + braces in strings; invalid → undefined; array top-level → parsed.

**Commit:** `feat(core): lenient JSON extraction`

---

## Task 3 — Config loader (`config.ts`)

`loadConfig(opts?: {configPath?; env?; cwd?}): Promise<FusionixConfig>`:
1. Read bundled `../config/default.config.json` via `new URL(..., import.meta.url)`.
2. Merge external file if `opts.configPath` || `env.FUSIONIX_CONFIG` || `<cwd>/fusionix.config.json` exists (shallow-merge top-level, presets merged by key).
3. Env overrides: `FUSIONIX_DEFAULT_GATEWAY`→gateway, `FUSIONIX_DEFAULT_PRESET`→defaultPreset.
`redactPreset(p)` → `{name, description, panel_size, web}` (§5.2). `listPresetsRedacted(config)`.

**Tests:** default config loads with 6 presets + gateway; env override changes gateway/defaultPreset; external file merges/overrides a preset; `redactPreset` hides slugs and emits `panel_size`.

**Commit:** `feat(core): config loader with env + file overrides`

---

## Task 4 — Request normalization (`normalize.ts`) — §6.8 (CRITICAL)

`normalizeRequest(request, config): ExecutionPlan`. Order: defaults → default preset → `plugins[0].preset` → explicit overrides → bypass flag → **validate** → plan.

Trigger/validation (throw `FusionixError`):
- `>1` fusionix plugin → `invalid_request`.
- top-level `model` concrete (not "fusionix") AND no fusionix plugin → `not_a_fusionix_request`.
- not a fusionix request at all (model not "fusionix", no plugin) → `not_a_fusionix_request`.
- `model==="fusionix"` & no `plugins` → synthesize implicit plugin from defaults.
- `messages` missing/empty → `invalid_request`; no user message → `invalid_request`.
- `analysis_models` present but empty → `invalid_request`.
- resolved panel empty / judge missing / writer missing → `invalid_request`.
- `max_tool_calls` present & not positive int → `invalid_request`.
- `stream` present & not boolean → `invalid_request`.

Resolution: panel = `analysis_models` ?? preset.panel; judge = `plugin.model` ?? preset.judge; writer = (top `model`!=="fusionix" ? top model : preset.writer); web = `plugin.enabled===false`? n/a : preset.web (default true); writerTemperature = `request.temperature` ?? preset.temperature; writerMaxTokens = `request.max_tokens` ?? preset.maxTokens; panel/judge temperature = preset.temperature; maxToolCalls = `plugin.max_tool_calls` ?? defaults.maxToolCalls; bypass = `plugin.enabled===false`.

`ExecutionPlan`: `{ runId, panel[], judge, writer, web, bypass, maxToolCalls, panelTemperature?, judgeTemperature?, writerTemperature?, writerMaxTokens?, panelSystem?, judgeSystem?, writerSystem?, presetName?, messages }`.

**Tests (table-driven):** default `{model:"fusionix"}` → general-high plan; `analysis_models` overrides preset & beats preset panel; `plugin.model` = judge; concrete top `model` = writer, plugin.model = judge (the §6.8 example); `enabled:false` → bypass; preset+analysis_models → analysis_models wins; every validation error code; `max_tool_calls:0`/`-1`/`1.5` → invalid; empty messages → invalid.

**Commit:** `feat(core): request normalization and validation (§6.8)`

---

## Task 5 — Messages + prompts (`messages.ts`, `prompts.ts`) — §14

`foldRoles(messages)`: map `developer`→`system` (fold). `findLastUserMessage`. `renderCompactPrompt(messages)`: single user turn → its text; else compact `role: content` transcript (system constraints + turns). `contentToString` (handle string | content-part array).

`prompts.ts`: PANEL_SYSTEM, JUDGE_SYSTEM, WRITER_SYSTEM (verbatim §14.1/2/3 instruction text, minus the inline `{{prompt}}`/`{{answers}}` tail which we send as messages). `composeSystem(base, presetSystem?)`. `renderAnswers(panel)` (only successful, label by model, include assumptions/risks/citations). `renderJudgeUser(prompt, answers)`, `renderWriterUser(prompt, analysisJson)`.

`buildPanelMessages(plan)` = `[{role:"system", content: composeSystem(PANEL_SYSTEM, plan.panelSystem)}, ...foldRoles(plan.messages)]`.

**Tests:** developer folded to system; single-user compact == the text; multi-turn compact includes roles; panel messages = instruction system + caller messages (caller system preserved); `renderAnswers` skips failed members; content-part array flattened.

**Commit:** `feat(core): message handling and pipeline prompts (§14)`

---

## Task 6 — Gateway client (`gateway/openrouter.ts`, `gateway/web.ts`)

`OpenRouterGateway({ apiKey, baseUrl, fetch?, referer?, title?, categories? })`. `chat(req, {signal}): Promise<GatewayCallResult>` POSTs `{gateway}/chat/completions` with `{model, messages, temperature?, max_tokens?, stream:false, usage:{include:true}}`, headers `Authorization: Bearer`, optional `HTTP-Referer`/`X-OpenRouter-Title`/`X-Title`/`X-OpenRouter-Categories`. Returns `{ content, usage:{prompt_tokens,completion_tokens,total_tokens,cost?}, raw, id }`. Non-2xx → `FusionixError("gateway_error")` (never leak key/auth state). `listModels()` + `getGeneration(id)` best-effort (catch → undefined). `web.ts`: `applyWeb(model, web)` → `web? model+":online" : model`.

**Tests (mock fetch):** request body has `usage.include=true`, model, temperature; headers set when configured; parses content+usage+cost; 401/500 → `gateway_error`; `applyWeb` suffix logic; `listModels`/`getGeneration` swallow errors.

**Commit:** `feat(core): OpenRouter gateway client with usage accounting + web variant`

---

## Task 7 — Cost (`cost.ts`)

`aggregateUsage(results): { usage:{prompt_tokens,completion_tokens,total_tokens}, costUsd: number|null }`. Sum tokens; sum `cost` only when present; `costUsd=null` if no call reported cost (§8.1).

**Tests:** sums tokens+cost; null when none report cost; partial costs summed.

**Commit:** `feat(core): cost/usage aggregation`

---

## Task 8 — Panel stage (`pipeline/panel.ts`)

`runPanel(plan, deps): Promise<{responses: PanelResponse[]; calls: GatewayCallResult[]}>`. For each panel model **in parallel**, call gateway with `applyWeb(model, plan.web)` and panel messages. On success: `extractJson` → if object, map to `PanelResponse` (answer/assumptions/risks/citations; raw text as answer if not parseable, NO repair §14.1); base `model` is the resolved slug (not the `:online` variant). On failure: `{model, error:{message}}` in place. Returns in **resolved panel order**. Honors `signal`.

**Tests (mock):** 3 models → 3 responses in order; one throws → `{model,error}` in position, others ok; non-JSON text → raw text as `answer`; JSON parsed into fields; `:online` used in call when web but `model` stays base slug; usage collected for cost.

**Commit:** `feat(core): panel stage with partial-failure + resolved order`

---

## Task 9 — Judge stage (`pipeline/judge.ts`)

`runJudge(plan, prompt, panel, deps): Promise<{analysis, calls}>`. Build judge messages (JUDGE_SYSTEM+presetSystem, user = renderJudgeUser(prompt, renderAnswers(panel))). Call judge model (no web). `extractJson` → validate shape (`coerceAnalysis`: ensure all 6 arrays). On parse fail → **one repair**: re-ask same judge model "convert your previous output to the exact JSON shape" with prev text; parse again. Still fail → `FusionixError("judge_failed")`.

**Tests (mock):** valid JSON → analysis; messy→repair→valid (2 calls); both fail → `judge_failed`; missing arrays coerced to `[]`; no web on judge call.

**Commit:** `feat(core): judge stage with one repair attempt (§14.2)`

---

## Task 10 — Writer stage (`pipeline/writer.ts`)

`runWriter(plan, prompt, analysis, deps): Promise<{answer, call}>`. Messages: WRITER_SYSTEM+presetSystem, user = renderWriterUser(prompt, JSON.stringify(analysis)). Use `writerTemperature`/`writerMaxTokens`; writer no web. Empty content or throw → `FusionixError("writer_failed")`.

**Tests (mock):** returns content as answer; passes temperature/max_tokens; throw/empty → `writer_failed`.

**Commit:** `feat(core): writer stage (§14.3)`

---

## Task 11 — Orchestration (`pipeline/run.ts`) + `index.ts`

`runFusionix(request, opts: { config?, apiKey, fetch?, signal?, now?, randomId?, maxRequestDurationMs?, referer?, title?, categories?, onProgress? }): Promise<FusionixRunResult>`.
1. `config = opts.config ?? await loadConfig()`. `plan = normalizeRequest(request, config)` (validation here).
2. Build gateway. Deadline: `AbortController` aborting at `maxRequestDurationMs` (default 180000), linked to `opts.signal`.
3. **Bypass** (`plan.bypass`): single writer call (caller messages, writer model, web if plan.web). Result extras: `run_id`, `duration_ms`, `web`; omit panel/analysis (§6.7).
4. Else: `onProgress("panel")` → runPanel. If zero successes → `all_panel_failed`. `onProgress("judge")` → runJudge(survivors). `onProgress("writer")` → runWriter. Deadline → if panel has ≥1 success proceed; judge/writer timeout → respective 502 (§17).
5. Aggregate cost across all calls. Shape `FusionixRunResult`: `{ runId, answer, panel (resolved order), analysis, usage, costUsd|null, durationMs, web: "used"|"off"|"unsupported", maxToolCallsEnforced:false, model: writer }`.
6. `web`: `"off"` if `!plan.web`; `"used"` if web requested & a panel call succeeded; `"unsupported"` if requested but all web attempts failed yet pipeline continued.

`index.ts` re-exports `runFusionix`, `loadConfig`, `normalizeRequest`, `listPresetsRedacted`, `FusionixError`, types.

**Tests (mock fetch, no network):** happy path 3-panel → answer + analysis + panel order + cost summed + web "used"; one panel fails → survives; all fail → `all_panel_failed`; bypass → answer only, no panel/analysis, web "off"; deadline with 1 survivor → proceeds; web=false → "off".

**Commit:** `feat(core): pipeline orchestration, timeout, result shaping`

---

## Task 12 — CLI (`packages/cli/src/*`)

`index.ts`: `parseArgs` for all §10.2 flags. Prompt from arg or stdin. Build `FusionixChatCompletionRequest` (`model:"fusionix"`, plugin from `--preset`/`--panel`/`--judge`/`--writer`/`--max-tool-calls`/`--no-web`). `--local` → `runFusionix(req, {apiKey: OPENROUTER_API_KEY, referer, title})`. Non-local in Phase 1 → friendly error: hosted is Phase 2, use `--local`. `--format` text|json|md (default md on TTY, json on pipe). `--show-analysis` includes analysis in md/text. `--log` writes JSONL run record. `--max-cost` warns (best-effort estimate via `listModels`; warn-not-block when price unknown, §8.2). `--stream` streams writer tokens (best-effort SSE) in local mode. `--version`/`--help`.

`format.ts`: `renderMarkdown(result, {showAnalysis})`, `renderText`, `renderJson`. `stdin.ts`: read piped stdin.

**Tests:** parse flags → request shape; `--panel a,b,c` → analysis_models; `--no-web` → plugin web false (via enabled? no—use a `web:false` mapping: CLI sets plugin with web disabled by sending `analysis`? — represent via request: set `--no-web` → we pass `web:false` to runFusionix through plan; since request has no web field, CLI passes `web` override through opts). md/json/text rendering; missing key → clear error; non-local → guidance error. (Mock core or run with injected fetch.)

**Commit:** `feat(cli): local deliberation CLI with formats, logging, max-cost`

> Note: `--no-web` — the wire request has no `web` field; CLI maps `--no-web` to the resolved plan via a core option `webOverride`, or by setting the chosen preset's web off. Implement `webOverride?: boolean` on `runFusionix` opts (and on normalize) so CLI/SDK can force web off without a preset edit. Default undefined = use preset/plugin.

---

## Task 13 — Build, link, real smoke test

`npm run build` (tsc -b, both packages emit dist + .d.ts; verify shebang on cli bin — add `#!/usr/bin/env node` to cli `index.ts`; if tsc drops it, prepend in a tiny postbuild). `npm link` cli (or `node packages/cli/dist/index.js`). Real run (uses `OPENROUTER_API_KEY`, costs a few cents):

```
fusionix "Compare SQLite and Postgres for lightweight agent coordination." --local --preset general-budget --show-analysis
```

Expected: panel→judge→writer, final answer, `cost_usd` populated, panel in order. Verify acceptance command with `general-high` too (smaller prompt to bound cost). Capture output to confirm §18 Phase-1 "done" criteria.

**Commit:** `chore: build, link, verified end-to-end smoke test`

---

## Task 14 — Docs + review

Root `README.md`: what Fusionix is (§20 one-liner), Phase-1 status, install/build, `--local` usage, config + env, the §6.4 line. `packages/core/README.md` + `packages/cli/README.md` brief. Run `superpowers:requesting-code-review` (code-reviewer agent) against the plan; address findings. `superpowers:verification-before-completion` before declaring done.

**Commit:** `docs: Phase 1 readme + usage`

---

## Definition of done (Phase 1, §18)

- `npm test` green (all core + cli unit tests, mocked gateway).
- `npm run build` clean (no type errors).
- `fusionix "…" --local --preset general-high` runs panel→judge→writer, returns an answer, `cost_usd` populated from gateway usage, panel in resolved order, caller system messages preserved, panel/judge parse-failure rules per §14.
- No slugs in core logic (only in `config/default.config.json`). No secrets logged.
