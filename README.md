# Fusion

> Fusion gives hard questions a second, third, and fourth opinion. It runs a panel of models, asks a judge to compare their answers, and gives you one synthesized result — available as an API, CLI, SDK, or Claude skill.

Fusion is an OpenRouter-shaped multi-model deliberation engine. It sends your prompt to several models in parallel, asks a judge model to compare the answers, and asks a writer model to produce one synthesized response.

```text
user request
→ panel models answer independently
→ judge compares panel answers
→ writer produces the final answer
→ result returned to caller
```

**OpenAI-compatible for the answer, Fusion-shaped for the extras.** A stock OpenAI client pointed at the endpoint with `model: "fusion"` gets the final answer in `choices[0].message.content`. The panel answers and judge analysis ride in a non-standard `fusion` field — reachable via the Fusion SDK or by reading the raw JSON.

---

## Status

**Phase 1 — Core pipeline + local CLI.** This is what ships today:

- `packages/core` — request normalization, the panel → judge → writer pipeline, single-model bypass, cost tracking, and result shaping. No web server, CLI, or UI code.
- `packages/cli` — a thin terminal wrapper. In Phase 1 it runs in `--local` mode, calling the gateway directly with your own `OPENROUTER_API_KEY`.

The hosted API, authentication and key storage, the SDK, the Claude skill, and the landing page arrive in later phases (see `fusion-spec.md` §18). Until then, `fusion` requires `--local`.

---

## Requirements

- **Node.js ≥ 23.6** for development (the repo runs TypeScript directly via native type-stripping and the built-in test runner). The compiled output runs on Node ≥ 18.
- An OpenRouter API key in `OPENROUTER_API_KEY` for `--local` runs.
- Zero external runtime or test dependencies — only `typescript` and `@types/node` for builds.

## Install & build

```bash
npm install        # links workspaces, installs dev deps
npm run build      # tsc -b → dist/ + .d.ts for both packages
npm test           # full unit-test suite, mocked gateway, no network
```

Make the `fusion` command available on your PATH:

```bash
cd packages/cli && npm link    # then `fusion --help`
```

…or run the built bin directly: `node packages/cli/dist/index.js --help`.

## CLI usage

```bash
export OPENROUTER_API_KEY=sk-or-...

fusion "Compare SQLite and Postgres for lightweight agent coordination." --local --preset general-high
fusion "Review this architecture" --local --preset architecture-review --show-analysis
cat spec.md | fusion --local --preset research-high
```

Key options (`fusion --help` for the full list):

| Option | Meaning |
|---|---|
| `--local` | Required in Phase 1. Runs locally against `OPENROUTER_API_KEY`. |
| `--preset <slug>` | One of the presets below. |
| `--panel <a,b,c>` | Override panel models. |
| `--judge <model>` / `--writer <model>` | Override judge / writer models. |
| `--no-web` | Disable gateway-native web search. |
| `--format <text\|json\|md>` | Output format (default: `md` on a TTY, `json` when piped). |
| `--show-analysis` | Include the judge analysis in `md`/`text` output. |
| `--stream` | Stream the final answer token-by-token. |
| `--log <path>` | Write a JSON run record. |
| `--max-cost <usd>` | Warn/abort before the run when the estimate exceeds this (best-effort). |

### Latency

Three sequential stages over large models commonly take **30–90 seconds**, and the panel and judge complete before any answer token appears — expect a quiet window (the CLI prints stage progress to stderr on a TTY, and `--stream` shows the answer as it is written).

## Presets

`general-high`, `general-budget`, `research-high`, `research-budget`, `code-review`, `architecture-review`. Defined in `packages/core/config/default.config.json`. The specialized presets carry domain-tuned panel/judge/writer system prompts — that catalog is product surface, not boilerplate.

## Configuration

Model slugs are **data, not code**: they live in `packages/core/config/default.config.json` (verified against `GET {gateway}/models`; model IDs drift, so re-verify before deploying). Core never hard-codes slugs.

Resolution order: bundled default → external file (`FUSION_CONFIG`, or `fusion.config.json` in the working directory) → environment overrides.

Environment variables used in Phase 1:

```text
OPENROUTER_API_KEY      # gateway calls in --local mode
FUSION_DEFAULT_GATEWAY  # override the gateway base URL
FUSION_DEFAULT_PRESET   # override the default preset
FUSION_HTTP_REFERER     # optional OpenRouter attribution
FUSION_APP_TITLE        # optional OpenRouter attribution
```

## Architecture

```text
packages/core   pure pipeline: normalize → panel → judge → writer; cost; result shaping
packages/cli    thin terminal wrapper (--local in Phase 1)
docs/plans      implementation plan
```

The same core powers the CLI, the SDK, and the hosted API, so all surfaces behave identically.

## Cost

`--local` runs are paid by your own gateway key. A 3-model panel plus a judge and a writer is roughly 4–5× a single completion. Each run reports `cost_usd` from gateway-reported usage (e.g. `$0.01` on `general-budget`, ~`$0.10` on `general-high` with web).

---

Built by [IKANGAI](https://ikangai.com). See `fusion-spec.md` for the full specification.
