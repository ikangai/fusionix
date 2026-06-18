# @ikangai/fusion-cli

The `fusion` command — run multi-model deliberation (panel → judge → writer) from the terminal.

In Phase 1 the CLI runs in **`--local`** mode, calling the gateway directly with your own `OPENROUTER_API_KEY`. The hosted default arrives in Phase 2.

```bash
export OPENROUTER_API_KEY=sk-or-...

fusion "Compare SQLite and Postgres for lightweight agent coordination." --local --preset general-high
fusion "Review this architecture" --local --preset architecture-review --show-analysis
cat spec.md | fusion --local --preset research-high --format json
```

## Options

```text
[prompt]                     Prompt. If omitted, read stdin.
--preset <slug>              general-high, general-budget, research-high,
                             research-budget, code-review, architecture-review
--panel <a,b,c>              Comma-separated panel models
--judge <model>              Judge model
--writer <model>             Writer model
--max-tool-calls <n>         Advisory in v1
--no-web                     Disable gateway-native web search
--format <text|json|md>      Output format (default: md on TTY, json on pipe)
--api-url <url>              Hosted API base (Phase 2)
--local                      Run local orchestration with OPENROUTER_API_KEY
--stream                     Stream the final answer
--show-analysis              Include judge analysis in md/text output
--log <path>                 Write a JSON run record
--max-cost <usd>             Warn/abort before run when the estimate exceeds this
--version
--help
```

Exit codes: `0` success · `1` runtime/gateway error or missing key · `2` usage error (bad args, no prompt, non-`--local` in Phase 1).

## Install

```bash
npm install && npm run build
cd packages/cli && npm link   # puts `fusion` on PATH
```

See the [repository README](../../README.md) for the full picture.
