/**
 * CLI entry logic (spec §10). Phase 1 supports `--local` only (the hosted API
 * arrives in Phase 2). Returns a process exit code; all I/O is injectable so the
 * flow is testable without a network or a real TTY.
 */
import { appendFile } from "node:fs/promises";
import {
  runFusionix as defaultRunFusionix,
  loadConfig as defaultLoadConfig,
  normalizeRequest,
  estimateCost,
  toChatCompletion,
  isFusionixError,
  OpenRouterGateway,
} from "@ikangai/fusionix-core";
import type {
  FusionixChatCompletionRequest,
  FusionixConfig,
  PriceEntry,
  RunFusionixOptions,
} from "@ikangai/fusionix-core";
import { parseCliArgs } from "./args.ts";
import type { OutputFormat } from "./args.ts";
import { buildRequest } from "./request.ts";
import { renderJson, renderMarkdown, renderText, renderExtras } from "./format.ts";
import { readStdin as defaultReadStdin } from "./stdin.ts";

const DEFAULT_VERSION = "0.1.0";

const HELP = `fusionix — multi-model deliberation (panel → judge → writer)

Usage:
  fusionix [prompt] [options]
  cat file | fusionix --local --preset research-high

Options:
  --preset <slug>         general-high, general-budget, research-high, research-budget,
                          code-review, architecture-review
  --panel <a,b,c>         Comma-separated panel models
  --judge <model>         Judge model
  --writer <model>        Writer model
  --max-tool-calls <n>    Advisory in v1
  --no-web                Disable gateway-native web search
  --format <text|json|md> Output format (default: md on TTY, json on pipe)
  --api-url <url>         Hosted API base (Phase 2)
  --local                 Run locally against OPENROUTER_API_KEY (required in Phase 1)
  --stream                Stream the final answer
  --show-analysis         Include judge analysis in md/text output
  --log <path>            Append a JSON run record (JSONL; one line per run)
  --max-cost <usd>        Warn/abort before run when the estimate exceeds this

v0.9 extensions (Fugu-inspired; §22):
  --only-provider <a,b>   Restrict the panel to these providers
  --exclude-provider <a>  Drop these providers from the panel
  --writer-strategy <s>   Aggregator selection: fixed | top-ranked | capability
  --topology <t>          Panel coordination: standard | debate
  --route                 Route to a single best-fit model (skip deliberation)
  --mode <fast|deliberate> Operating point (fast = route to one model)
  --version
  --help

Phase 1 runs in --local mode only; the hosted API arrives in Phase 2.
`;

export interface MainDeps {
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
  readStdin?: () => Promise<string>;
  runFusionix?: (request: FusionixChatCompletionRequest, opts: RunFusionixOptions) => Promise<import("@ikangai/fusionix-core").FusionixRunResult>;
  loadConfig?: () => Promise<FusionixConfig>;
  loadPrices?: (apiKey: string, baseUrl?: string) => Promise<Record<string, PriceEntry>>;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Append a line to the run log (§16 JSONL); defaults to fs.appendFile. */
  appendFile?: (path: string, data: string) => Promise<void>;
  version?: string;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errCodeSuffix(e: unknown): string {
  return isFusionixError(e) ? ` (${e.code})` : "";
}

async function defaultLoadPrices(apiKey: string, baseUrl?: string): Promise<Record<string, PriceEntry>> {
  const gw = new OpenRouterGateway({ apiKey, baseUrl: baseUrl ?? "https://openrouter.ai/api/v1" });
  const models = await gw.listModels();
  const table: Record<string, PriceEntry> = {};
  for (const m of models ?? []) {
    const prompt = Number(m.pricing?.prompt);
    const completion = Number(m.pricing?.completion);
    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
      table[m.id] = { prompt, completion };
    }
  }
  return table;
}

interface MaxCostOutcome {
  /** Abort the run because the estimate exceeds the cap. */
  abort: boolean;
  /** The config loaded for the estimate, so the run can reuse it (avoids a second load; §8.2). */
  config?: FusionixConfig;
}

/** Decide whether --max-cost should abort the run, and surface the config it loaded. Best-effort (§8.2). */
async function checkMaxCost(
  maxCost: number,
  request: FusionixChatCompletionRequest,
  webOverride: boolean | undefined,
  prompt: string,
  apiKey: string,
  env: Record<string, string | undefined>,
  deps: MainDeps,
  stderr: (s: string) => void,
): Promise<MaxCostOutcome> {
  let config: FusionixConfig;
  try {
    config = await (deps.loadConfig ?? defaultLoadConfig)();
  } catch (e) {
    // Could not even load config — let the run load it and surface the real error.
    stderr(`fusionix: --max-cost estimate unavailable (${errMessage(e)}). Proceeding.\n`);
    return { abort: false };
  }
  try {
    const normOpts: { webOverride?: boolean } = {};
    if (webOverride !== undefined) normOpts.webOverride = webOverride;
    const plan = normalizeRequest(request, config, normOpts);
    // Use the resolved gateway (config wins over the env var) so prices match the run target.
    const prices = await (deps.loadPrices ?? defaultLoadPrices)(apiKey, config.gateway);
    const { estimateUsd, missing } = estimateCost(plan, prices, { promptChars: prompt.length });
    if (missing.length > 0) {
      stderr(`fusionix: --max-cost: price unknown for ${missing.join(", ")}; cannot enforce pre-flight. Proceeding.\n`);
      return { abort: false, config };
    }
    if (estimateUsd !== null && estimateUsd > maxCost) {
      stderr(`fusionix: estimated cost $${estimateUsd.toFixed(4)} exceeds --max-cost $${maxCost.toFixed(4)}. Aborting.\n`);
      return { abort: true, config };
    }
    if (estimateUsd !== null) {
      stderr(`fusionix: estimated cost $${estimateUsd.toFixed(4)} (max $${maxCost.toFixed(4)}).\n`);
    }
    return { abort: false, config };
  } catch (e) {
    // Config loaded fine but estimation failed (e.g. price fetch). Reuse the config; skip the estimate.
    stderr(`fusionix: --max-cost estimate unavailable (${errMessage(e)}). Proceeding.\n`);
    return { abort: false, config };
  }
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((s) => void process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => void process.stderr.write(s));
  const run = deps.runFusionix ?? defaultRunFusionix;
  const version = deps.version ?? DEFAULT_VERSION;

  let args;
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    stderr(`fusionix: ${errMessage(e)}\n`);
    return 2;
  }

  if (args.help) {
    stdout(HELP);
    return 0;
  }
  if (args.version) {
    stdout(`${version}\n`);
    return 0;
  }
  if (args.format && !["text", "json", "md"].includes(args.format)) {
    stderr(`fusionix: invalid --format '${args.format}' (expected text|json|md)\n`);
    return 2;
  }
  if (args.writerStrategy && !["fixed", "top-ranked", "capability"].includes(args.writerStrategy)) {
    stderr(`fusionix: invalid --writer-strategy '${args.writerStrategy}' (expected fixed|top-ranked|capability)\n`);
    return 2;
  }
  if (args.topology && !["standard", "debate"].includes(args.topology)) {
    stderr(`fusionix: invalid --topology '${args.topology}' (expected standard|debate)\n`);
    return 2;
  }
  if (args.mode && !["fast", "deliberate"].includes(args.mode)) {
    stderr(`fusionix: invalid --mode '${args.mode}' (expected fast|deliberate)\n`);
    return 2;
  }

  // Resolve the prompt: positional, else stdin.
  let prompt = args.prompt?.trim();
  if (!prompt) {
    const piped = (await (deps.readStdin ?? defaultReadStdin)()).trim();
    if (piped) prompt = piped;
  }
  if (!prompt) {
    stderr("fusionix: no prompt provided (pass a prompt argument or pipe text on stdin)\n");
    return 2;
  }

  // Phase 1: only --local is functional.
  if (!args.local) {
    stderr(
      "fusionix: hosted mode is not available yet (Phase 1). Re-run with --local to run the pipeline locally using OPENROUTER_API_KEY.\n",
    );
    return 2;
  }

  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    stderr("fusionix: OPENROUTER_API_KEY is not set (required for --local mode).\n");
    return 1;
  }
  if (args.apiUrl) {
    stderr("fusionix: --api-url is ignored in --local mode (it targets the hosted API, Phase 2).\n");
  }

  const { request, webOverride } = buildRequest(args, prompt);
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  const format: OutputFormat = args.format ?? (isTTY ? "md" : "json");

  let preloadedConfig: FusionixConfig | undefined;
  if (args.maxCost !== undefined) {
    const { abort, config } = await checkMaxCost(args.maxCost, request, webOverride, prompt, apiKey, env, deps, stderr);
    if (abort) return 1;
    preloadedConfig = config;
  }

  const runOpts: RunFusionixOptions = { apiKey };
  // Reuse the config already loaded for the estimate so the run doesn't re-read it (no double load / TOCTOU).
  if (preloadedConfig) runOpts.config = preloadedConfig;
  if (webOverride !== undefined) runOpts.webOverride = webOverride;
  if (env.FUSIONIX_HTTP_REFERER) runOpts.referer = env.FUSIONIX_HTTP_REFERER;
  if (env.FUSIONIX_APP_TITLE) runOpts.title = env.FUSIONIX_APP_TITLE;
  if (isTTY) runOpts.onProgress = (stage) => stderr(`[fusionix] ${stage}…\n`);

  const streaming = args.stream && format !== "json";
  let streamedAny = false;
  if (streaming) {
    runOpts.onWriterDelta = (d) => {
      streamedAny = true;
      stdout(d);
    };
  }

  let result;
  try {
    result = await run(request, runOpts);
  } catch (e) {
    stderr(`fusionix: ${errMessage(e)}${errCodeSuffix(e)}\n`);
    return 1;
  }

  if (streaming && streamedAny) {
    stdout("\n\n");
    stdout(renderExtras(result, { showAnalysis: args.showAnalysis }, format === "text" ? "text" : "md"));
  } else if (format === "json") {
    stdout(renderJson(result));
  } else if (format === "text") {
    stdout(renderText(result, { showAnalysis: args.showAnalysis }));
  } else {
    stdout(renderMarkdown(result, { showAnalysis: args.showAnalysis }));
  }

  if (args.log) {
    try {
      // Run record (§16): timestamp, preset, resolved panel/judge/writer models, plus the
      // OpenAI-shaped result (usage, cost, web, max_tool_calls_enforced, panel errors).
      // Appended one JSON object per line so repeated runs accumulate as a JSONL run log.
      const record = {
        logged_at: new Date(result.created * 1000).toISOString(),
        preset: args.preset ?? null,
        models: {
          panel: result.panel ? result.panel.map((p) => p.model) : null,
          judge: result.judge ?? null,
          writer: result.model,
        },
        ...toChatCompletion(result),
      };
      await (deps.appendFile ?? appendFile)(args.log, JSON.stringify(record) + "\n");
    } catch (e) {
      stderr(`fusionix: could not write log to ${args.log}: ${errMessage(e)}\n`);
    }
  }

  return 0;
}
