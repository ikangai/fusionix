# @ikangai/fusion-core

The Fusion deliberation engine: request normalization, the panel → judge → writer pipeline, single-model bypass, cost tracking, and result shaping. Pure logic — no web server, CLI, or UI code. The same core powers the CLI, SDK, and hosted API.

## Local pipeline

```ts
import { runFusion } from "@ikangai/fusion-core";

const result = await runFusion(
  {
    model: "fusion",
    messages: [{ role: "user", content: "Compare ridge, lasso, and elastic-net regression." }],
    plugins: [{ id: "fusion", preset: "general-high" }],
  },
  { apiKey: process.env.OPENROUTER_API_KEY },
);

console.log(result.answer);   // synthesized final answer
console.log(result.panel);    // per-model answers, in resolved order (failures in place)
console.log(result.analysis); // judge: consensus / contradictions / blind spots / …
console.log(result.costUsd);  // summed from gateway usage; null if not reported
```

## Public API

| Export | Purpose |
|---|---|
| `runFusion(request, opts)` | Run the full pipeline (or single-model bypass) and return a `FusionRunResult`. |
| `normalizeRequest(request, config, opts?)` | Resolve a deterministic `ExecutionPlan` (spec §6.8) without calling the gateway. |
| `loadConfig(opts?)` | Load the bundled default config plus file/env overrides. |
| `listPresetsRedacted(config)` / `redactPreset(p)` | Public, slug-free preset listing (spec §5.2). |
| `toChatCompletion(result)` | Map a result to the OpenAI-compatible `chat.completion` shape with snake_case `fusion` extras (spec §6.3). |
| `estimateCost(plan, prices, opts?)` | Rough pre-flight cost estimate (spec §8.2). |
| `OpenRouterGateway` | The gateway client (`chat`, `streamChat`, `listModels`, `getGeneration`). |
| `FusionError` / `isFusionError` | Typed errors with code → HTTP status (spec §6.6). |

`runFusion` options include `apiKey`, `config`, `webOverride`, `onProgress`, `onWriterDelta` (streaming), `maxRequestDurationMs`, `signal`, and an injectable `gateway`/`fetch` for testing.

## Configuration

Model slugs are data, not code (spec §4) — they live in `config/default.config.json`, verified against `GET {gateway}/models`. Re-verify before deploying; IDs drift.

## Development

```bash
npm run build   # tsc -b
npm test        # node --test, mocked gateway, no network
```
