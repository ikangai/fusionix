# Fusionix — OpenRouter-Shaped Multi-Model Deliberation Engine

**Implementation specification for Claude Code**
Status: v0.10 — Phase 1 + Fugu/Trinity/Conductor extensions (§22, §23). (v0.8 was "FROZEN, Phase 1 only"; v0.9 added opt-in deliberation controls from the Sakana Fugu report (§22); v0.10 adds further opt-in coordination controls from the TRINITY and Conductor papers (§23). All extensions are off by default at the pipeline level.)
Owner: IKANGAI
Product domain: fusionix.ikangai.com
API base: https://fusionix.ikangai.com/api

---

## 0. Product idea

Fusionix is a small hosted-and-local tool that implements OpenRouter-style multi-model deliberation from scratch.

It accepts a prompt, sends it to several models in parallel, asks a judge model to compare the answers, and asks a final writer model to produce one synthesized response.

The product should feel familiar to anyone who knows OpenRouter Fusion, but the pipeline is implemented by us. OpenRouter may be used as the model gateway; OpenRouter Fusion itself is not called. We implement the behavior.

---

## 1. Core behavior

```text
user request
→ panel models answer independently
→ judge compares panel answers
→ writer produces final answer
→ result returned to caller
```

1. **Panel** — send the same prompt to multiple models in parallel.
2. **Judge** — compare the panel answers; return structured JSON: consensus, contradictions, partial coverage, unique insights, blind spots, optional ranking.
3. **Writer** — produce the final user-facing answer from the original prompt and the judge analysis.

This is the core product and the default behavior. v0.9 (§22) and v0.10 (§23) add **opt-in, off-by-default** controls on top of this same pipeline — provider pool filtering, an adaptive (per-query) writer/aggregator, single-model routing, an optional debate round, a verifier accept-gate, a configurable writer access-list, and a sequential chain topology. With no extension options set, behavior is exactly the pipeline above.

---

## 2. Surfaces

Four surfaces over one shared core:

1. **CLI** — `fusionix "question here"`
2. **SDK** — `import { fuse } from "@ikangai/fusionix"; const result = await fuse("question here");`
3. **Claude skill** — invokes the hosted API or CLI for hard questions.
4. **Hosted Web API** — `POST https://fusionix.ikangai.com/api/v1/chat/completions`

Public landing page: `https://fusionix.ikangai.com`, linking to API docs, CLI install, SDK docs, and skill install.

---

## 3. Compatibility goal

Fusionix is **OpenRouter-shaped, not OpenRouter-dependent.** It accepts a request that looks like OpenRouter Fusion but runs our own pipeline:

```jsonc
{
  "model": "fusionix",
  "messages": [
    { "role": "user", "content": "What are the strongest arguments for and against carbon taxes?" }
  ],
  "plugins": [
    {
      "id": "fusionix",
      // Illustrative slugs only — use valid gateway model IDs (§4).
      "analysis_models": [
        "anthropic/claude-opus-latest",
        "openai/gpt-latest",
        "google/gemini-pro-latest"
      ],
      "model": "openai/gpt-latest",
      "max_tool_calls": 8,
      "enabled": true
    }
  ]
}
```

Mapping (these are **our** fields; we own the surface):

| Request field | Meaning in our implementation |
|---|---|
| `model` (top-level) | Final **writer** model. If `"fusionix"`, use the default writer. When deliberation is enabled and `model` is a concrete slug (not `"fusionix"`), it is the writer; the plugin `model` remains the judge. |
| `messages` | User/system conversation input (§14.0). |
| `plugins[].id = "fusionix"` | Enables deliberation config. |
| `analysis_models` | Panel models. |
| `model` inside plugin | **Judge** model. |
| `max_tool_calls` | Accepted for surface compatibility; **advisory** in v1 (§15). |
| `enabled` | If `false`, bypass deliberation and run a single model call (§6.7). |

So `{"model": "anthropic/claude-...", "plugins": [{"id": "fusionix", "model": "openai/gpt-..."}]}` means: judge with OpenAI, write with Claude. Full resolution and the deliberation trigger are in §6.8. For v1, support only one Fusionix plugin per request. The OpenAI-compatibility boundary is in §6.4.

---

## 4. Default request behavior

If the caller sends only:

```json
{
  "model": "fusionix",
  "messages": [{ "role": "user", "content": "Compare ridge, lasso, and elastic-net regression." }]
}
```

Fusionix uses built-in defaults:

```ts
{
  panel:  ["<configured-claude-model>", "<configured-openai-model>", "<configured-gemini-model>"],
  judge:  "<configured-openai-model>",
  writer: "<configured-openai-model>",
  maxToolCalls: 8,
  web: true
}
```

The exact default slugs live in deployment config, never in core logic. **The default deployment config must be populated with currently valid gateway model IDs**, verified against `GET {gateway}/models`. Do not bake concrete slugs into core; they drift.

---

## 5. Presets

Presets expand locally. Support a small set:

```text
general-high
general-budget
research-high
research-budget
code-review
architecture-review
```

```json
{
  "model": "fusionix",
  "messages": [{ "role": "user", "content": "Review this architecture." }],
  "plugins": [{ "id": "fusionix", "preset": "architecture-review" }]
}
```

If both `preset` and `analysis_models` are provided, `analysis_models` wins (§6.8).

Presets are a primary differentiator (§12): a generic panel is commodity; presets tuned to where IKANGAI actually sells (municipal fact-check, architecture/code review, legal-risk) are not. Treat the preset catalog as product surface, not boilerplate.

### 5.1 Preset schema

```ts
interface FusionixPreset {
  name: string;
  description: string;
  panel: string[];
  judge: string;
  writer: string;
  web: boolean;
  temperature?: number;
  maxTokens?: number;
  panelSystem?: string;
  judgeSystem?: string;
  writerSystem?: string;
}
```

`temperature` / `maxTokens` here are stage defaults used when the request does not override (§6.8).

### 5.2 Public preset listing

`GET /api/v1/presets` is **public (no auth required)** and returns a **redacted** view — no internal model IDs by default:

```json
[
  {
    "name": "architecture-review",
    "description": "Review technical architecture for correctness, risk, tradeoffs, and missing pieces.",
    "panel_size": 3,
    "web": false
  }
]
```

Preset definitions themselves use placeholder/configured model slugs, populated per deployment (§4).

---

## 6. Hosted API

### 6.1 Endpoint

```text
POST https://fusionix.ikangai.com/api/v1/chat/completions
```

Intentionally OpenAI/OpenRouter-shaped.

### 6.2 Request

```ts
interface FusionixChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  plugins?: FusionixPlugin[];
  temperature?: number;   // writer only (§6.8)
  max_tokens?: number;    // writer only (§6.8)
  stream?: boolean;
}

interface FusionixPlugin {
  id: "fusionix";
  preset?: string;
  analysis_models?: string[];
  model?: string;          // judge
  max_tool_calls?: number; // advisory in v1 (§15)
  enabled?: boolean;
}
```

### 6.3 Response (non-streaming)

OpenAI-compatible, with a non-standard `fusionix` field for the extras:

```json
{
  "id": "fusionix-run-...",
  "object": "chat.completion",
  "created": 1730000000,
  "model": "fusionix",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Final synthesized answer..." },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 1234, "completion_tokens": 567, "total_tokens": 1801 },
  "fusionix": {
    "run_id": "fusionix-run-...",
    "panel": [
      {
        "model": "anthropic/claude-opus-latest",
        "answer": "Panel answer...",
        "assumptions": [],
        "risks": [],
        "citations": []
      }
    ],
    "analysis": {
      "consensus": [],
      "contradictions": [],
      "partial_coverage": [],
      "unique_insights": [],
      "blind_spots": [],
      "ranking": []
    },
    "cost_usd": 0.123,
    "duration_ms": 12000,
    "web": "used",
    "max_tool_calls_enforced": false
  }
}
```

`choices[0].message.content` is always the final answer. `fusionix.panel[]` is returned **in resolved panel order** (§6.8), not completion order; each entry carries the parsed answer plus assumptions/risks/citations when present. **Failed panel members remain in `fusionix.panel` in their original position with `{ model, error }` and no `answer`.** If a panel model returned text that could not be parsed as JSON, `answer` holds the raw text (§14). `cost_usd` may be `null` when the gateway reports no cost (§8). `web` is `"used" | "off" | "unsupported"`. `max_tool_calls_enforced` reports whether the gateway mechanism honored `max_tool_calls` (§15).

v1 omits `system_fingerprint`. If a client needs the closer OpenAI shape it may be added later as a nullable field (`"system_fingerprint": null`).

### 6.4 OpenAI-compatibility boundary

- **Drop-in:** a stock OpenAI client pointed at the base URL with `model: "fusionix"` and `messages` gets the final answer in `choices[0].message.content`. Streaming of that answer works (§6.5).
- **Not drop-in:** `plugins` is not an OpenAI concept — OpenAI SDKs pass it via `extra_body` (or equivalent). The `fusionix` response field is non-standard and is ignored by stock OpenAI SDKs, so panel answers and analysis are not reachable through a vanilla client. To get the extras, use the Fusionix SDK (§9) or read the raw JSON.

Document this as **"OpenAI-compatible for the answer, Fusionix-shaped for the extras."** Put that line in the landing page and docs.

### 6.5 Streaming contract

When `stream: true`:

- Stream OpenAI-shaped `chat.completion.chunk` events for the **final answer only** (the writer stage). Panel and judge are never streamed to the client.
- Immediately before the terminal `data: [DONE]`, emit one non-standard event carrying the extras:

```text
event: fusionix
data: { "run_id": "...", "panel": [...], "analysis": {...}, "cost_usd": 0.12, "duration_ms": 12000, "web": "used", "max_tool_calls_enforced": false }
```

The Fusionix SDK reads this event. Raw OpenAI SDK users should **not** rely on receiving it — some streaming abstractions drop unknown SSE events. (If we control the SDK parser, the extras may alternatively ride in the last normal chunk under an extension field; the custom event is sufficient for v1.)

- Optional progress events let clients show status during the silent panel/judge phases:

```text
event: fusionix.progress
data: { "stage": "panel" | "debate" | "chain" | "judge" | "writer" }
```

Panel and judge complete before any answer token streams, so expect a quiet front-end window; progress events (or a caller-side spinner) cover it. Three sequential stages over large models commonly take 30–90s; set this expectation on the landing page.

### 6.6 Error response

Errors use an OpenAI-shaped object:

```json
{
  "error": {
    "message": "All panel models failed.",
    "type": "fusionix_error",
    "code": "all_panel_failed",
    "run_id": "fusionix-run-..."
  }
}
```

HTTP mapping:

| Situation | HTTP | code |
|---|---|---|
| Invalid request shape (see §6.8 list) | 400 | `invalid_request` |
| Concrete `model` with no fusionix plugin (§6.8) | 400 | `not_a_fusionix_request` |
| Missing/invalid Fusionix API key | 401 | `unauthorized` |
| Prompt too large | 413 | `prompt_too_large` |
| Per-key concurrency / rate / usage limit exceeded | 429 | `limit_exceeded` |
| All panel models failed | 502 | `all_panel_failed` |
| Judge failed (after one repair) | 502 | `judge_failed` |
| Writer failed or timed out | 502 | `writer_failed` |
| Gateway failure | 502 | `gateway_error` |
| Internal error | 500 | `internal_error` |

Gateway authentication failure maps to **502**, not 401, so the response never reveals the state of a stored gateway key.

### 6.7 Single-model bypass (`enabled: false`)

When the Fusionix plugin has `enabled: false`:

- Use the top-level `model` as the single model.
- If the top-level `model` is `"fusionix"`, use the resolved/default writer model.
- Return the `fusionix` extras with only `run_id`, `duration_ms`, and `web: "off"` (unless web was used); omit `panel` and `analysis`.

This behavior lives in core, so CLI and SDK local mode behave identically.

### 6.8 Request normalization

Core resolves a single execution plan before any model call, so behavior is deterministic across CLI, SDK, and hosted API.

**Trigger.** Deliberation runs when the top-level `model` is `"fusionix"`, **or** when `plugins[0].id === "fusionix"` and its `enabled` is not `false`. A request with a concrete `model` and **no** fusionix plugin is not a Fusionix request: return `400 not_a_fusionix_request`. v1 is not a general single-model proxy (§19). (Relaxing this to passthrough later is a one-line change.)

**Implicit plugin.** If `model === "fusionix"` and no `plugins` array is present, synthesize an implicit Fusionix plugin from deployment defaults (§4). All `plugins[0]` references below then operate on that implicit plugin.

**Resolution order:**

1. Load deployment defaults.
2. Apply the default preset from config (`FUSIONIX_DEFAULT_PRESET`), if any.
3. Apply `plugins[0].preset`, if present.
4. Apply explicit request overrides:
   - `plugins[0].analysis_models` overrides the preset panel.
   - `plugins[0].model` overrides the judge model.
   - top-level `model` overrides the writer model, unless it is `"fusionix"` (then use the resolved/default writer).
   - `max_tokens` applies to the **writer call only**.
   - `temperature` applies to the **writer call only**.
   - panel and judge use the preset/config `temperature`/`maxTokens` defaults; per-stage request controls are a future addition.
5. If `plugins[0].enabled === false`, bypass panel/judge and call only the resolved writer (§6.7).
6. **Validate** before any gateway call. Reject with `400 invalid_request` when:
   - `messages` is missing or empty
   - no user message can be found
   - more than one Fusionix plugin is present
   - `analysis_models` is present but empty
   - the resolved panel is empty, or the resolved judge (except in chain topology, §23.4, which has no judge stage) or writer is missing
   - `max_tool_calls` is provided but is not a positive integer
   - `stream` is provided but is not a boolean

   Then enforce per-key limits (413 prompt size, 429 concurrency/rate). Model **presence** (non-empty resolved panel/judge/writer) is always validated here; model **existence** on the gateway is validated only best-effort (§8.2) and never blocks gateways without a `/models` endpoint.
7. Execute. Return `fusionix.panel` in resolved panel order; failed panel members remain in position with `{ model, error }` and no `answer`.

So `{"model": "anthropic/claude-...", "plugins": [{"id": "fusionix", "model": "openai/gpt-..."}]}` resolves to: judge with OpenAI, write with Claude, panel from the default/preset.

### 6.9 Health

```text
GET /api/health
```

```json
{ "status": "ok", "version": "0.1.0" }
```

---

## 7. Authentication and spend control

This section is the difference between a product and a way to lose money. The pipeline runs N panel calls plus a judge and a writer — roughly 4–5× a single completion for a 3-model panel — so unbounded public access against an operator-funded gateway key is a financial liability.

### 7.1 Hosted API authentication

```http
Authorization: Bearer <FUSIONIX_API_KEY>
```

A development mode may disable auth for local testing only. (`GET /api/v1/presets` and `GET /api/health` are public; §5.2, §6.9.)

### 7.2 Who pays for model calls

Two modes; v1 ships the first.

- **Bring-your-own gateway key (default, v1).** Each Fusionix account stores its own gateway credential (e.g. an OpenRouter key), encrypted at rest. `FUSIONIX_API_KEY` authenticates the caller; model calls are paid by that account's gateway key. The hosted service fronts no model spend, so there is no operator *financial* exposure. This also fits the municipal/enterprise "bring your own contract" pattern.

  BYO does **not** mean "no risk" — storing a customer's gateway key is a real trust boundary, which is exactly why the storage design in §7.6 (HMAC-hashed Fusionix keys, AEAD-encrypted gateway secrets) is mandatory, not optional. Communicate the boundary honestly on the landing page (§12).
- **Managed billing (later phase, non-goal for v1).** Fusionix uses an operator gateway key and bills a margin via metering. Requires a real billing system; deferred (§19).

### 7.3 Per-key limits (enforced server-side)

Recommended v1 defaults:

```ts
{
  maxPanelSize: 8,
  maxPromptChars: 60000,
  maxRequestDurationMs: 180000,
  maxConcurrentRequests: 4
}
```

Reject requests exceeding these before any model call (§6.6: 413 for prompt size, 429 for concurrency/rate). Limits are per Fusionix API key (`limits_json`) and may be raised per account later.

### 7.4 Spend caps

Optional per-key daily/monthly USD caps, computed from gateway-reported cost (§8). In BYO mode a cap protects the user's own gateway budget. When a model's price is unknown, the cap cannot be pre-checked — enforce post-hoc from returned usage and note that pre-flight enforcement was unavailable.

### 7.5 Credentials per surface

- **Local** (CLI `--local`, SDK `fuseLocal`, core directly): uses the user's own `OPENROUTER_API_KEY` and calls the gateway directly. No Fusionix service, no `FUSIONIX_API_KEY`, no hosted-service exposure.
- **Hosted** (CLI default, SDK `fuse`, skill, raw API): `FUSIONIX_API_KEY` authenticates; the account's stored gateway key pays; per-key limits and caps apply.

### 7.6 Gateway key storage (v1)

Store one encrypted gateway credential per Fusionix API key. Minimum schema:

- `fusionix_api_keys`: `id`, `key_hash`, `name`, `limits_json`, `disabled_at`, `created_at`
- `gateway_credentials`: `api_key_id`, `provider`, `encrypted_secret`, `created_at`, `updated_at`

Implementation notes:

- Fusionix API keys are high-entropy random tokens. Hash them with **HMAC-SHA256 using a server-side secret (pepper)** from env — not argon2/bcrypt. Slow password hashes defend low-entropy human passwords; they add latency with no benefit for random API tokens.
- Encrypt gateway secrets with application-level AEAD (AES-256-GCM or libsodium secretbox) using a key from `FUSIONIX_ENCRYPTION_KEY`.
- Never log or return a gateway secret after creation.
- Provide admin-only scripts to create API keys and attach/update gateway credentials (§13.2).

You do not need a full account system in v1 — just enough to authenticate a caller and retrieve the right gateway key.

---

## 8. Cost (minimal path, in scope)

A full provider-independent cost engine is a non-goal. A thin gateway-usage path is in scope, because `cost_usd`, `--max-cost`, and spend caps depend on it.

### 8.1 Actual cost

On each model call, request usage accounting from the gateway. For OpenRouter, send `usage: { include: true }`; the response then includes token usage and cost. Sum cost across panel + judge + writer for `fusionix.cost_usd`. If a call omits cost, optionally backfill from `GET {gateway}/generation?id={id}` (best-effort; never blocks). For gateways that report no cost, set `cost_usd: null`.

### 8.2 Estimation and the models endpoint

`--max-cost` and pre-flight spend caps need a per-model price table. Hydrate it from `GET {gateway}/models` (cached, refreshed periodically), with a small bundled snapshot as fallback. Estimate = projected tokens × per-model price across the resolved panel/judge/writer. When a model's price is unknown, estimation is unavailable; `--max-cost` warns rather than blocking, and the run still reports actual cost afterward.

`GET {gateway}/models` is **best-effort**. Some OpenAI-compatible gateways (LiteLLM, vLLM, Ollama-compatible servers) may not implement it. If it is unavailable, skip gateway model-existence validation and cost estimation, unless deployment config provides a local model registry / price table. Actual cost from returned usage (§8.1) still applies wherever the gateway provides it.

### 8.3 Reporting

Track and expose total token usage, per-model usage where available, estimated cost (pre-run, when computable), actual cost, and duration.

---

## 9. SDK

Package: `@ikangai/fusionix`. The default import is a **hosted API client**; local orchestration is a separate subpath export, so the default SDK stays light and does not pull in orchestration/retry/provider code.

```ts
import { fuse } from "@ikangai/fusionix";          // hosted API client
import { fuseLocal } from "@ikangai/fusionix/local"; // local orchestration (uses core)
```

### 9.1 Hosted use

```ts
import { fuse } from "@ikangai/fusionix";
const result = await fuse("Compare SQLite and Postgres for agent coordination.");
console.log(result.answer);
```

`fuse()` calls the hosted API and requires `FUSIONIX_API_KEY`. Make this and the API URL obvious in the SDK docs.

### 9.2 Local use

```ts
import { fuseLocal } from "@ikangai/fusionix/local";
const result = await fuseLocal("Review this code architecture.", {
  preset: "architecture-review",
  panel:  ["<configured-claude-model>", "<configured-openai-model>", "<configured-gemini-model>"],
  judge:  "<configured-openai-model>",
  writer: "<configured-openai-model>"
});
```

`fuseLocal()` runs the pipeline directly against the gateway using `OPENROUTER_API_KEY`. The CLI `--local` flag uses this same path.

### 9.3 SDK result

```ts
interface FusionixResult {
  answer: string;
  analysis?: FusionixAnalysis;   // omitted in bypass mode (§6.7)
  panel?: PanelResponse[];     // omitted in bypass mode (§6.7)
  usage?: Usage;
  costUsd?: number;            // undefined when the gateway reports no cost
  durationMs: number;
  runId: string;
  web: "used" | "off" | "unsupported";
  maxToolCallsEnforced: boolean;
}
```

### 9.4 Panel and analysis types

```ts
interface PanelResponse {
  model: string;
  answer?: string;                // parsed answer; raw text if parse failed; absent if the member failed
  assumptions?: string[];
  risks?: string[];
  citations?: { title?: string; url: string }[];
  error?: { message: string };    // present if this panel model failed
}

interface FusionixAnalysis {
  consensus: string[];
  contradictions: { topic: string; stances: { model: string; stance: string }[] }[];
  partialCoverage: { models: string[]; point: string }[];
  uniqueInsights: { model: string; insight: string }[];
  blindSpots: string[];
  ranking: string[];
}
```

(The SDK uses camelCase; the wire `fusionix` object uses snake_case as in §6.3.)

---

## 10. CLI

```text
fusionix [prompt] [options]
```

### 10.1 Examples

```bash
fusionix "Compare SQLite and Postgres for lightweight agent coordination."
fusionix "Review this architecture" --preset architecture-review
cat spec.md | fusionix --preset research-high
```

### 10.2 Options

```text
[prompt]                     Prompt. If omitted, read stdin.
--preset <slug>              general-high, general-budget, research-high, etc.
--panel <a,b,c>              Comma-separated panel models.
--judge <model>              Judge model.
--writer <model>             Writer model.
--max-tool-calls <n>         Advisory in v1 (§15).
--no-web                     Disable web search/fetch.
--format <text|json|md>      Output format (default: md on TTY, json on pipe).
--api-url <url>              Default https://fusionix.ikangai.com/api.
--local                      Run local orchestration with OPENROUTER_API_KEY instead of the hosted API.
--stream                     Stream the final answer.
--show-analysis              Include judge analysis in md/text output.
--log <path>                 Write JSON run log.
--max-cost <usd>             Warn/abort before run when the estimate exceeds this (needs a price table; §8.2).
--version
--help
```

Default behavior: without `--local`, call the hosted API (`FUSIONIX_API_KEY`); with `--local`, run the pipeline locally (`OPENROUTER_API_KEY`). Default API URL `https://fusionix.ikangai.com/api`; the CLI appends `/v1/chat/completions`.

---

## 11. Claude skill

Small by design. Its job: decide whether the question is worth deliberating; call Fusionix; return the final answer; optionally summarize the analysis on request.

Use Fusionix for: research questions, expert critique, architecture review, compare/contrast, ambiguous questions, high-stakes questions.

Do not use Fusionix for: simple factual questions, small rewrites, tactical coding questions, trivial summaries.

**Invocation order** (do not make CLI installation the default dependency):

1. If `FUSIONIX_API_KEY` is available, call the hosted API directly (`POST .../api/v1/chat/completions`).
2. Else, if the `fusionix` CLI is installed and configured, run it: `fusionix "<prompt>" --preset general-high --format json`.
3. Else, if `OPENROUTER_API_KEY` is present and the CLI exists, run local: `fusionix "<prompt>" --local --preset general-high --format json`.
4. Else, explain that Fusionix is not configured and what the user needs to set.

Parse the result, use `.answer`, and summarize `consensus` / `contradictions` / `blind_spots` only when asked.

---

## 12. Landing page

Domain: `https://fusionix.ikangai.com`.

Explain: what Fusionix is; why panel + judge can help; when to use it and when not to; CLI/SDK/API/skill usage; pricing/usage cost; contact and IKANGAI branding. Set the latency expectation (§6.5). Use the line from §6.4 verbatim.

Positioning:

> Fusionix gives hard questions a second, third, and fourth opinion. It runs a panel of models, asks a judge to compare their answers, and gives you one synthesized result — available as an API, CLI, SDK, or Claude skill.

Be honest about the BYO trust boundary (§7.2) — do not imply "no risk because BYO." Use:

> In hosted mode, Fusionix stores your gateway key encrypted and uses it only to run your requests. In local mode, your gateway key never leaves your machine.

Where the value lives: the pipeline itself is commodity, so the differentiators are the packaging across four surfaces under one brand, EU/own-hosting for clients who will not route through a third party directly, and domain-tuned presets. Lead with those, not with "we run three models."

---

## 13. Internal implementation

TypeScript monorepo.

```text
fusionix/
├─ packages/
│  ├─ core/        # request normalization, message handling, preset expansion, panel/judge/writer, cost tracking, result shaping
│  ├─ cli/         # thin wrapper: hosted API or local core
│  ├─ sdk/         # hosted client (default) + /local subpath (fuseLocal)
│  ├─ api/         # hosted endpoints; auth + per-key limits + spend caps + key storage; uses core
│  ├─ admin/       # fusionix-admin CLI
│  └─ skill/
├─ apps/
│  └─ landing/     # fusionix.ikangai.com (Next.js, Astro, or static)
├─ docs/
└─ examples/
```

### 13.1 core

Contains no web-server, CLI, or UI code: request normalization (§6.8), message handling (§14.0), preset expansion, panel/judge/writer execution, single-model bypass (§6.7), cost tracking, result shaping.

### 13.2 api and admin

`api` hosts `POST /api/v1/chat/completions`, `GET /api/v1/presets`, `GET /api/health`. It owns authentication, per-key limits (§7.3), spend caps (§7.4), gateway key storage (§7.6), error mapping (§6.6), and BYO gateway-key handling. It calls the same core as CLI and SDK.

`fusionix-admin` provisions keys (BYO mode cannot work without it):

```bash
fusionix-admin create-key --name "Client A"
fusionix-admin set-gateway-key --key-id <id> --provider openrouter
fusionix-admin disable-key --key-id <id>
```

`set-gateway-key` reads the secret from **stdin** or the `FUSIONIX_GATEWAY_SECRET` env var — never a command-line flag, so it does not land in shell history or `ps` output.

### 13.3 Configuration

Environment:

```text
OPENROUTER_API_KEY=...           # local mode / gateway calls
FUSIONIX_API_KEY=...               # hosted client auth (CLI/SDK)
FUSIONIX_ENCRYPTION_KEY=...        # AEAD key for stored gateway secrets (api package)
FUSIONIX_GATEWAY_SECRET=...        # used only by fusionix-admin set-gateway-key (alternative to stdin)
FUSIONIX_CONFIG=...                # explicit external config file path (overrides <cwd>/fusionix.config.json)
FUSIONIX_DEFAULT_PRESET=general-high
FUSIONIX_DEFAULT_GATEWAY=https://openrouter.ai/api/v1
FUSIONIX_HTTP_REFERER=...          # optional OpenRouter attribution (§13.4)
FUSIONIX_APP_TITLE=...             # optional OpenRouter attribution (§13.4)
FUSIONIX_LOG_LEVEL=info
```

Local config file uses placeholder/configured slugs, populated per deployment:

```json
{
  "gateway": "https://openrouter.ai/api/v1",
  "defaultPreset": "general-high",
  "presets": {
    "general-high": {
      "panel":  ["<configured-claude-model>", "<configured-openai-model>", "<configured-gemini-model>"],
      "judge":  "<configured-openai-model>",
      "writer": "<configured-openai-model>"
    }
  }
}
```

A deployment may also supply a **local model registry / price table** here, used for validation and cost estimation when `GET {gateway}/models` is unavailable (§8.2).

### 13.4 OpenRouter attribution (optional)

When the gateway is OpenRouter, the gateway client may send attribution headers so usage appears in OpenRouter's app rankings:

- `HTTP-Referer: ${FUSIONIX_HTTP_REFERER}`
- `X-OpenRouter-Title: ${FUSIONIX_APP_TITLE}` (`X-Title` is the legacy fallback)

Optionally also `X-OpenRouter-Categories` (e.g. `cli-agent`). These are sent only when configured and are never required for the pipeline to work.

---

## 14. Core pipeline prompts

### 14.0 Message handling

The hosted API accepts a full `messages` array; the templates below show the instruction text, not the only content sent. Core preserves caller-provided system/developer messages and does not flatten the request to the last user message. Preserve caller-provided roles where the gateway supports them; if the gateway does not support `developer`, fold developer messages into the system prompt.

- **Panel:** send the panel instruction (§14.1) as the system prompt, followed by the caller's original `messages` (including any caller system message). The model answers the real conversation as a panelist and returns the JSON shape.
- **Judge / writer:** these reason over panel answers rather than continuing the chat, so they receive the judge/writer instruction as the system prompt plus a **compact rendering** of the original user request and any relevant caller system constraints — not the full multi-turn transcript.
- `{{prompt}}` denotes that rendered user request (the last user message for single-turn requests; a compact rendering of the conversation otherwise). `{{answers}}` is the panel outputs; `{{analysis}}` is the judge analysis.

Do not drop caller-provided system messages.

Try structured-output / JSON mode only when the gateway adapter explicitly supports it; otherwise use prompt-only JSON. Do not build a capability matrix in v1.

### 14.1 Panel

```text
You are one expert in a panel answering the user's question independently.
Give a direct, useful answer. Be specific. If you are uncertain, state your uncertainty.
Return JSON:
{ "answer": "...", "assumptions": [], "risks": [], "citations": [] }
User question:
{{prompt}}
```

The parsed JSON populates `PanelResponse` (§9.4). **If panel JSON parsing fails, do not run a repair call in v1** — keep the raw text as `answer` and continue. This keeps cost predictable.

### 14.2 Judge

```text
You compare several model answers to the same user question.
Do not write the final answer. Compare the answers.
Return JSON:
{ "consensus": [], "contradictions": [], "partial_coverage": [], "unique_insights": [], "blind_spots": [], "ranking": [] }
User question:
{{prompt}}
Answers:
{{answers}}
```

The writer depends on judge JSON, so allow **exactly one repair attempt**: if parsing fails, ask the same judge model once to convert its previous output into the required JSON shape. If that also fails, return `502 judge_failed` (§6.6).

### 14.3 Writer

```text
Write the final answer to the user's question using the judge analysis.
Rules:
- Lead with the answer.
- Use consensus as high-confidence material.
- When the panel disagrees, resolve it: weigh the evidence, decide which side is correct, and state the resolution — do not merely report that a disagreement exists.
- Preserve useful unique insights.
- Do not mention the panel, judge, or internal process.
User question:
{{prompt}}
Judge analysis:
{{analysis}}
```

(v0.9: the disagreement rule was strengthened from "Mention important disagreements when relevant" to the resolve-and-decide wording above, on all runs — §22.2.)

---

## 15. Web search/fetch

v1 uses **gateway-native web only**. Do not implement a custom counted web-search/fetch tool loop — that would turn a focused product back into an agent framework.

- Input is the boolean `web` (default `true`; `--no-web` sets `false`). `true` means "use the gateway's built-in web mechanism where available."
- For OpenRouter, prefer the simplest gateway-native mechanism: an `:online` model variant where appropriate, or the OpenRouter web plugin if configured. Confirm the exact current mechanism at implementation time rather than pinning it here.
- The writer does not use web by default.
- `max_tool_calls` is accepted for surface compatibility but is **advisory** in v1: it is only honored if the selected gateway mechanism exposes a matching control. The response reports `max_tool_calls_enforced: true | false`.
- Outcome is reported as `web: "used" | "off" | "unsupported"`. If web is requested but unavailable, continue without it and set `web: "unsupported"`.

A proper counted search/fetch loop can be added later (§19 non-goal for v1).

---

## 16. Logging

Each run gets a `run_id`. Log: request timestamp, preset, panel models, judge model, writer model, duration, usage, cost, errors, whether web tools were used, and `max_tool_calls_enforced`. Never log gateway or Fusionix API keys, or stored gateway secrets.

Optional full JSONL run log for the local CLI:

```bash
fusionix "question" --local --log run.jsonl
```

---

## 17. Error and timeout behavior

- One panel model fails → continue.
- All panel models fail → `502 all_panel_failed`.
- Judge fails (after one repair attempt) → `502 judge_failed`.
- Writer fails or times out → `502 writer_failed`. (The simplified judge produces no prose, so there is no synthesis to fall back to.)
- Web tools fail → continue without web and mark the run (`web: "unsupported"`).
- Request exceeds a per-key limit → reject before any model call (413 prompt size / 429 concurrency-rate).
- Gateway auth failure → 502 `gateway_error` (do not expose stored-key state).

**Timeout / cancellation.** When `maxRequestDurationMs` is reached:

- Abort outstanding gateway calls where possible.
- If the panel has at least one successful answer at the deadline, proceed to judge with the survivors; if it has zero, return `502 all_panel_failed`.
- If the judge or writer times out, return the corresponding 502 (`judge_failed` / `writer_failed`).

Hosted responses use the §6.6 error object.

---

## 18. Implementation phases

**Phase 1 — Core + local CLI.** Build the core pipeline (request normalization §6.8, message handling §14.0, single-model bypass §6.7) and the local CLI.
Done when `fusionix "hard question" --local --preset general-high` runs panel → judge → writer and returns an answer, with `cost_usd` populated from gateway usage (§8.1), panel returned in resolved order, caller system messages preserved, and panel/judge parse-failure rules behaving per §14. In Phase 1 the hosted API does not exist yet, so the CLI runs in `--local` mode; the hosted default in §10 applies from Phase 2 onward.

**Phase 2 — Hosted API.** Build `POST /api/v1/chat/completions`, `GET /api/v1/presets`, `GET /api/health`, **plus** authentication (§7.1), gateway key storage (§7.6), `fusionix-admin` (`create-key`, `set-gateway-key`, `disable-key`), per-key limits (§7.3), the minimal cost path (§8), the request-validation list and error mapping (§6.6, §6.8), and the streaming contract (§6.5).
Done when a key plus gateway credential can be provisioned via `fusionix-admin`, `fusionix "hard question"` runs end-to-end through `https://fusionix.ikangai.com/api` with auth, returns the answer and `cost_usd`, rejects over-limit / non-Fusionix / invalid requests with the right HTTP codes, `GET /api/health` returns the §6.9 shape, and `GET /api/v1/presets` returns redacted entries without auth.

**Phase 3 — SDK.** Build `@ikangai/fusionix` (hosted client) and `@ikangai/fusionix/local` (`fuseLocal`).
Done when `await fuse("hard question")` works against the hosted API and `await fuseLocal("...")` works against the gateway directly.

**Phase 4 — Claude skill.** Build a skill that follows the §11 invocation order.
Done when Claude uses Fusionix for a hard question and returns the final answer.

**Phase 5 — Landing page.** Build `fusionix.ikangai.com`.
Done when it explains the product, sets latency expectations, uses the §6.4 line and the §12 BYO phrasing, and links to CLI, SDK, API, and skill docs.

---

## 19. Non-goals for v1

Do not build these in v1:

- ~~debate rounds~~ — **superseded in v0.9**: added as the opt-in `--topology debate` (§22.5).
- critic judge
- MCP server
- ~~complex capability/backend matrix~~ — v0.9 adds a *small, coarse, hand-maintained* capability prior (§22.6), not a full matrix.
- offline rejudge
- ~~general single-model passthrough proxy~~ — still not a passthrough proxy, but v0.9 adds opt-in single-model **routing** that selects a model from the pool (§22.4); the `400 not_a_fusionix_request` rule for a concrete model with no plugin is unchanged (§6.8).
- **counted / multi-step web-search/fetch tool loop** (v1 uses gateway-native web only; §15)
- **full provider-independent cost engine** (the thin gateway-usage path in §8 *is* in scope)
- **managed/margin billing and metering** (BYO gateway key is the v1 model; §7.2)
- enterprise account management — orgs, roles, SSO, seats, dashboards (basic per-key auth and limits in §7 *are* in scope)
- UI for viewing runs
- prompt-template versioning system
- full eval harness

These can come later if the product proves useful.

---

## 20. One-sentence framing

Fusionix gives hard questions multiple independent model perspectives, compares them with a judge, and returns one synthesized answer — available as an API, CLI, SDK, and Claude skill.

---

## 21. Phase 1 build target (for Claude Code)

Start here:

1. Core request normalization (§6.8) and message handling (§14.0).
2. Local CLI pipeline (`--local`).
3. OpenRouter gateway calls with `usage: { include: true }` (§8.1).
4. Simple presets (§5).
5. Panel order and partial-failure behavior (§6.3, §17).
6. Judge JSON, one repair attempt (§14.2).
7. Writer answer (§14.3).

---

## 22. Fugu-inspired extensions (v0.9)

These extensions are inspired by the **Sakana Fugu technical report** (Sakana AI, 2026), which studies learned orchestration of frontier models and — while benchmarking against OpenRouter Fusion — identifies the limitations of a *fixed* deliberation pipeline. fusionix is a deterministic, zero-ML gateway pipeline, so it cannot learn an orchestrator; instead it adopts the report's *structural* ideas as small, deterministic, **opt-in** controls. See `docs/design/fugu-extensions.md` for the full mapping and rationale.

**Invariants for every extension below:**
- **Off by default at the pipeline level.** With no v0.9 option set, the pipeline *shape*, models, and routing are exactly §1 — no new stage, no model swap, no routing. (Regression-guarded: QA case `N8`.) The one deliberate cross-cutting change is the writer prompt (§14.3), which is strengthened to *resolve* disagreements on every run as a v0.9 product decision (§22.2); the judge prompt is unchanged unless `writer_strategy` is `top-ranked`.
- **Deterministic, resolved pre-call (§6.8).** All selection happens in normalization before any gateway call; nothing is decided from live model output except the adaptive writer, which is a pure function of the judge analysis.
- **Resolvable from preset or request.** Each option may be set on a preset (§5.1) or per-request via the plugin / CLI flag.

### 22.1 Provider pool filtering

`plugins[0].only_providers` / `exclude_providers` (CLI `--only-provider` / `--exclude-provider`, CSV) filter the resolved panel by provider prefix (`anthropic`, `openai`, `google`, …). `only` keeps only those providers; `exclude` then drops providers; both are applied in normalization. Filtering the panel to empty is `400 invalid_request` with a distinct message. (Fugu §2–3: configurable agent pools that favor/exclude providers for compliance.)

### 22.2 Adaptive aggregator (writer strategy)

`plugins[0].writer_strategy` (CLI `--writer-strategy`): `fixed` (default) | `top-ranked` | `capability`. For a non-fixed strategy, the writer is chosen from the **surviving panel models** after the judge:
- `top-ranked`: the judge's #1 ranked model. To make this reliable, **only for this strategy** the judge prompt is augmented with a model-id ranking instruction (`JUDGE_RANKING_INSTRUCTION`, appended to §14.2); `resolveRankedModel` then maps a ranking entry (slug, `[n]` index, or family substring) back to a surviving model. The default/`capability` judge prompt is unchanged.
- `capability`: the surviving panelist best-suited to the detected query category (§22.6). The category is detected from the **user turn only** (like routing, §22.4).

It always falls back to the configured writer when nothing resolves. `result.model` reports the model that actually wrote. Separately and **always on** (all strategies, including the default): the writer prompt (§14.3) is strengthened to *resolve* disagreements rather than merely report them — a v0.9 product change to the default writer behavior. (Fugu §4.4: a fixed aggregator bottlenecks the system; Fugu-Ultra picks the aggregator per query.)

### 22.3 Operating points (`--mode`)

`--mode fast|deliberate`: `deliberate` is the default full pipeline; `fast` is sugar for routing to a single model (§22.4). Mirrors Fugu's two variants (latency-aware single-worker vs. multi-agent quality).

### 22.4 Single-model routing

`plugins[0].route` (CLI `--route`, or `--mode fast`): fusionix picks the single best-fit model from the pool via the capability prior (§22.6) and a deterministic keyword category detection over the **user turn**, then runs it through the single-model bypass path (§6.7). Routing applies only to the `fusionix` meta-model: an explicit concrete `model` or `enabled:false` bypass wins, so a named model is never silently swapped. Routed runs surface `route_category` + `model_used` in the JSON extras and the CLI footer. This is **not** a passthrough proxy (§6.8's `not_a_fusionix_request` rule is unchanged). A single-model run (route, `--mode fast`, or `enabled:false`) is **mutually exclusive with a panel topology** (§22.5/§23.4): combining them is rejected with `400 invalid_request` rather than silently dropping the topology. (Fugu's latency-aware variant: route each query to the most capable single model.)

### 22.5 Debate topology

`plugins[0].topology` (CLI `--topology`): `standard` (default) | `debate`. `debate` inserts one inter-panel revision round between panel and judge — each surviving panelist sees the others' first answers and revises its own; the revised answers replace the round-1 answers for the judge and the result. Debate does not use web (§15) and can only improve or preserve the panel (a failed/empty revision keeps round-1). Surfaces a `debate` progress stage. (Fugu §4.4 "debate and aggregation".)

### 22.6 Capability prior

`packages/core/src/capabilities.ts` is a small, coarse, hand-maintained map of provider/family → strength tags, encoding the domain specializations the Fugu report observes (GPT→math, Gemini→science/recall, Opus→coding/debugging/cybersecurity). It is the one transferable idea from Fugu's training methodology (which fusionix cannot replicate without an ML loop) and powers §22.2 (`capability`) and §22.4. `detectCategory` is a deterministic, no-model keyword classifier. These are heuristics, not measurements, and model slugs drift — treat as product data, like the preset model lists (§4).

### 22.7 Deferred / not applicable

- **Access-list memory & intra-workflow isolation** (Fugu §3.2.2): the *static, within-pipeline* access list is now implemented in v0.10 as the writer access-list (§23.3) — Conductor showed it is pure prompt-string selection, not a tool-use mechanism. What remains deferred is the *dynamic, per-query, arbitrary-graph* access list (a workflow DSL).
- **Learned orchestration** (Fugu's SFT / sep-CMA-ES / GRPO): out of scope — fusionix is deterministic and zero-ML. The transferable crumb is the §22.6 capability prior.

Everything else follows the phase plan (§18).

---

## 23. TRINITY / Conductor extensions (v0.10)

A second wave of opt-in, deterministic controls inspired by the two papers the Fugu report builds on: **TRINITY** (Xu et al., *An Evolved LLM Coordinator*) and **Conductor** (Nielsen et al., *Learning to Orchestrate Agents in Natural Language*). As with §22, both papers' *trained* cores (evolution / RL) are out of scope for a zero-ML gateway; v0.10 adopts only their *structural* ideas. The §22 invariants apply: off by default at the pipeline level (QA group O), deterministic and resolved pre-call (§6.8), settable from preset or request. See `docs/design/fugu-extensions.md`.

### 23.1 Verifier accept-gate

`plugins[0].accept_on_consensus` (CLI `--accept-on-consensus`): TRINITY (§3.2) halts coordination when a Verifier returns ACCEPT. fusionix derives that signal deterministically from the judge output — when the judge reports **no contradictions AND no blind spots**, accept the strongest surviving panelist's answer (the judge's #1 ranked survivor, else the first) and **skip the writer synthesis**, saving one model call. The run reports `accepted_on_consensus` in the JSON extras and a footer marker; `result.model` is the accepted panelist. Off by default → the writer always runs.

### 23.2 Capability prior reconciled with measured winners

The §22.6 capability prior (`capabilities.ts`) is reconciled with TRINITY's *measured* per-task winners (TRINITY Table 1: Gemini-2.5-pro tops MATH500 + GPQA, Claude tops MMLU): Gemini gains `math`, Claude gains `recall`. The guiding principle (TRINITY §A.6, the RER objective) is **comparative advantage, not global strength** — a model owns the categories where it is *uniquely* best. Existing routes are unchanged (math still → GPT); the additions are better-placed fallbacks.

### 23.3 Writer access-list

`plugins[0].writer_access` (CLI `--writer-access`): `judge` (default) | `judge+panel` | `judge+top`. Conductor's per-step `access_list` is pure prompt-context selection (no tools). fusionix's writer saw only the judge analysis (a hardcoded one-element access list); this makes it configurable — `judge+panel` also grants the raw surviving panel answers, `judge+top` the top-ranked survivor's answer — for tasks where the judge's summary loses signal the synthesizer needs. Default is unchanged (analysis only).

### 23.4 Chain topology

`plugins[0].topology: "chain"` (CLI `--topology chain`): a sequential **planner → builder(s) → finalizer** pipeline. The panel models run in order, each seeing the accumulated work of the prior steps; the last step that produces content is the final answer. This is the asymmetric staged hand-off Conductor's data (§F.1, Fig. 8) shows wins on hard multi-step tasks — distinct from the parallel panel and the symmetric §22.5 debate round. There is **no judge or writer stage** in chain mode (so chain needs no judge model); chain steps may use web like the panel, and a failed/empty step is kept in place while the chain continues. Because chain has neither a judge nor a writer stage, the writer/judge-stage controls (`writer_strategy` §22.2, `writer_access` §23.3, `accept_on_consensus` §23.1) cannot apply: requesting any of them with `topology=chain` is rejected with `400 invalid_request` rather than silently ignored.

### 23.5 Deferred / not applicable (TRINITY / Conductor)

- **Multi-turn bounded coordination loop** and a **static workflow DSL** (config-authored `steps[]` with per-step access lists — Conductor's full artifact minus the learning): the coherent next direction, still zero-ML, but a substantial new subsystem. Roadmap.
- **Dynamic per-query role selection** (TRINITY's Thinker/Worker/Verifier logit): training-bound, and TRINITY's own ablation shows it can *hurt* some task types — fusionix's *fixed* role contracts (panel/judge/writer + the §23.1 verifier gate) are the sound deterministic analogue. Out of scope.
- **The learned coordinators themselves** (TRINITY's SLM head + sep-CMA-ES; Conductor's 7B + GRPO): out of scope — no training loop. Their transferable crumbs are realized as the §23.2 prior reconciliation and the §22.6 / §23.x structural controls.