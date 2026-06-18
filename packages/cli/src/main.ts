/**
 * CLI entry logic (spec §10). Phase 1 supports `--local` only (the hosted API
 * arrives in Phase 2). Returns a process exit code; all I/O is injectable so the
 * flow is testable without a network or a real TTY.
 */
import { writeFile } from "node:fs/promises";
import {
  runFusion as defaultRunFusion,
  loadConfig as defaultLoadConfig,
  normalizeRequest,
  estimateCost,
  toChatCompletion,
  isFusionError,
  OpenRouterGateway,
} from "@ikangai/fusion-core";
import type {
  FusionChatCompletionRequest,
  FusionConfig,
  PriceEntry,
  RunFusionOptions,
} from "@ikangai/fusion-core";
import { parseCliArgs } from "./args.ts";
import type { OutputFormat } from "./args.ts";
import { buildRequest } from "./request.ts";
import { renderJson, renderMarkdown, renderText, renderExtras } from "./format.ts";
import { readStdin as defaultReadStdin } from "./stdin.ts";

const DEFAULT_VERSION = "0.1.0";

const HELP = `fusion — multi-model deliberation (panel → judge → writer)

Usage:
  fusion [prompt] [options]
  cat file | fusion --local --preset research-high

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
  --log <path>            Write a JSON run record
  --max-cost <usd>        Warn/abort before run when the estimate exceeds this
  --version
  --help

Phase 1 runs in --local mode only; the hosted API arrives in Phase 2.
`;

export interface MainDeps {
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
  readStdin?: () => Promise<string>;
  runFusion?: (request: FusionChatCompletionRequest, opts: RunFusionOptions) => Promise<import("@ikangai/fusion-core").FusionRunResult>;
  loadConfig?: () => Promise<FusionConfig>;
  loadPrices?: (apiKey: string, baseUrl?: string) => Promise<Record<string, PriceEntry>>;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  writeFile?: (path: string, data: string) => Promise<void>;
  version?: string;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errCodeSuffix(e: unknown): string {
  return isFusionError(e) ? ` (${e.code})` : "";
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

/** Returns true if the run should be aborted due to --max-cost. Best-effort (§8.2). */
async function checkMaxCost(
  maxCost: number,
  request: FusionChatCompletionRequest,
  webOverride: boolean | undefined,
  prompt: string,
  apiKey: string,
  env: Record<string, string | undefined>,
  deps: MainDeps,
  stderr: (s: string) => void,
): Promise<boolean> {
  try {
    const config = await (deps.loadConfig ?? defaultLoadConfig)();
    const normOpts: { webOverride?: boolean } = {};
    if (webOverride !== undefined) normOpts.webOverride = webOverride;
    const plan = normalizeRequest(request, config, normOpts);
    // Use the resolved gateway (config wins over the env var) so prices match the run target.
    const prices = await (deps.loadPrices ?? defaultLoadPrices)(apiKey, config.gateway);
    const { estimateUsd, missing } = estimateCost(plan, prices, { promptChars: prompt.length });
    if (missing.length > 0) {
      stderr(`fusion: --max-cost: price unknown for ${missing.join(", ")}; cannot enforce pre-flight. Proceeding.\n`);
      return false;
    }
    if (estimateUsd !== null && estimateUsd > maxCost) {
      stderr(`fusion: estimated cost $${estimateUsd.toFixed(4)} exceeds --max-cost $${maxCost.toFixed(4)}. Aborting.\n`);
      return true;
    }
    if (estimateUsd !== null) {
      stderr(`fusion: estimated cost $${estimateUsd.toFixed(4)} (max $${maxCost.toFixed(4)}).\n`);
    }
    return false;
  } catch (e) {
    stderr(`fusion: --max-cost estimate unavailable (${errMessage(e)}). Proceeding.\n`);
    return false;
  }
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((s) => void process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => void process.stderr.write(s));
  const run = deps.runFusion ?? defaultRunFusion;
  const version = deps.version ?? DEFAULT_VERSION;

  let args;
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    stderr(`fusion: ${errMessage(e)}\n`);
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
    stderr(`fusion: invalid --format '${args.format}' (expected text|json|md)\n`);
    return 2;
  }

  // Resolve the prompt: positional, else stdin.
  let prompt = args.prompt?.trim();
  if (!prompt) {
    const piped = (await (deps.readStdin ?? defaultReadStdin)()).trim();
    if (piped) prompt = piped;
  }
  if (!prompt) {
    stderr("fusion: no prompt provided (pass a prompt argument or pipe text on stdin)\n");
    return 2;
  }

  // Phase 1: only --local is functional.
  if (!args.local) {
    stderr(
      "fusion: hosted mode is not available yet (Phase 1). Re-run with --local to run the pipeline locally using OPENROUTER_API_KEY.\n",
    );
    return 2;
  }

  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    stderr("fusion: OPENROUTER_API_KEY is not set (required for --local mode).\n");
    return 1;
  }
  if (args.apiUrl) {
    stderr("fusion: --api-url is ignored in --local mode (it targets the hosted API, Phase 2).\n");
  }

  const { request, webOverride } = buildRequest(args, prompt);
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  const format: OutputFormat = args.format ?? (isTTY ? "md" : "json");

  if (args.maxCost !== undefined) {
    const abort = await checkMaxCost(args.maxCost, request, webOverride, prompt, apiKey, env, deps, stderr);
    if (abort) return 1;
  }

  const runOpts: RunFusionOptions = { apiKey };
  if (webOverride !== undefined) runOpts.webOverride = webOverride;
  if (env.FUSION_HTTP_REFERER) runOpts.referer = env.FUSION_HTTP_REFERER;
  if (env.FUSION_APP_TITLE) runOpts.title = env.FUSION_APP_TITLE;
  if (isTTY) runOpts.onProgress = (stage) => stderr(`[fusion] ${stage}…\n`);

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
    stderr(`fusion: ${errMessage(e)}${errCodeSuffix(e)}\n`);
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
      const data = JSON.stringify(toChatCompletion(result)) + "\n";
      await (deps.writeFile ?? writeFile)(args.log, data);
    } catch (e) {
      stderr(`fusion: could not write log to ${args.log}: ${errMessage(e)}\n`);
    }
  }

  return 0;
}
