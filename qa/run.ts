/**
 * QA harness: drive the REAL fusionix CLI `main()` + REAL core pipeline through a
 * configurable FAKE gateway. Only the network boundary is stubbed, so argv, stdin,
 * env, output formatting, exit codes, --log file writes, --max-cost, streaming and
 * progress all behave exactly as for an end user — without spending money or hitting
 * OpenRouter. This is "production-like settings" minus the live network.
 *
 * Invoke:  node --conditions=development qa/run.ts [cli args...]
 * Scenario: env QA_SCENARIO = inline JSON, or QA_SCENARIO_FILE = path to JSON.
 * TTY:      env QA_TTY = "1" to simulate an interactive stdout (md default, progress).
 *
 * The scenario shape is documented in qa/scenarios/README is not needed; see fields below.
 */
import { main } from "../packages/cli/src/main.ts";
import type { MainDeps } from "../packages/cli/src/main.ts";
import {
  runFusionix as realRunFusionix,
  loadConfig as realLoadConfig,
} from "@ikangai/fusionix-core";
import type {
  ChatGateway,
  ChatRequest,
  ChatCallOptions,
  GatewayCallResult,
  PriceEntry,
} from "@ikangai/fusionix-core";

// ---------------------------------------------------------------------------
// Scenario model
// ---------------------------------------------------------------------------

type Mode = "json" | "text" | "empty" | "throw" | "raw";
interface Behavior {
  mode?: Mode;
  content?: string; // for mode "raw"
  message?: string; // for mode "throw"
  usage?: { p: number; c: number; cost?: number };
}
interface Scenario {
  latencyMs?: number;
  noCost?: boolean; // omit `cost` from every usage → costUsd should be null
  panel?: {
    answerPrefix?: string;
    default?: Behavior;
    models?: Record<string, Behavior>;
    onlineFails?: boolean; // ":online" variant throws → fallback to base (web unsupported)
    usage?: { p: number; c: number; cost?: number };
  };
  judge?: { first?: Behavior; repair?: Behavior; usage?: { p: number; c: number; cost?: number } };
  writer?: Behavior & { stream?: boolean };
  prices?: Record<string, PriceEntry> | null; // null → loadPrices throws (unavailable)
  backfill?: Record<string, number>; // generation id → cost (enables getGeneration)
}

function loadScenario(): Scenario {
  const inline = process.env.QA_SCENARIO;
  if (inline) return JSON.parse(inline) as Scenario;
  // QA_SCENARIO_FILE handled by the caller reading and passing inline; keep simple.
  return {};
}

const PANEL_MARK = "You are one expert in a panel";
const JUDGE_MARK = "You compare several model answers";
const WRITER_MARK = "Write the final answer";
const REPAIR_MARK = "You convert text into a single JSON object";

function systemText(req: ChatRequest): string {
  const sys = req.messages.find((m) => m.role === "system");
  return typeof sys?.content === "string" ? sys.content : "";
}
type Stage = "panel" | "judge" | "repair" | "writer" | "single";
function detectStage(req: ChatRequest): Stage {
  const s = systemText(req);
  if (s.startsWith(PANEL_MARK)) return "panel";
  if (s.startsWith(REPAIR_MARK)) return "repair";
  if (s.startsWith(JUDGE_MARK)) return "judge";
  if (s.startsWith(WRITER_MARK)) return "writer";
  return "single"; // bypass / raw single-model call
}

const VALID_ANALYSIS = {
  consensus: ["Both agree X is true."],
  contradictions: [{ topic: "approach", stances: [{ model: "A", stance: "use SQLite" }, { model: "B", stance: "use Postgres" }] }],
  partial_coverage: [{ models: ["A"], point: "covers indexing only" }],
  unique_insights: [{ model: "C", insight: "WAL mode matters for concurrency" }],
  blind_spots: ["Neither discusses backup/restore."],
  ranking: ["A", "B", "C"],
};

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeFakeGateway(sc: Scenario): ChatGateway {
  const panelUsage = sc.panel?.usage ?? { p: 10, c: 5, cost: 0.5 };
  const judgeUsage = sc.judge?.usage ?? { p: 20, c: 10, cost: 0.25 };
  const writerUsage = sc.writer?.usage ?? { p: 30, c: 15, cost: 0.125 };
  const answerPrefix = sc.panel?.answerPrefix ?? "ans";

  const usageOf = (u: { p: number; c: number; cost?: number }) => {
    const out: GatewayCallResult["usage"] = { prompt_tokens: u.p, completion_tokens: u.c, total_tokens: u.p + u.c };
    if (!sc.noCost && u.cost !== undefined) out.cost = u.cost;
    return out;
  };

  function panelContent(baseModel: string, b: Behavior): string {
    const mode = b.mode ?? "json";
    if (mode === "json") return JSON.stringify({ answer: `${answerPrefix}-${baseModel}`, assumptions: ["assumes recent data"], risks: ["may be outdated"], citations: [{ title: "Doc", url: "https://example.com/doc" }] });
    if (mode === "text") return `Plain prose answer from ${baseModel}; no JSON here.`;
    if (mode === "empty") return "";
    if (mode === "raw") return b.content ?? "";
    return "";
  }

  async function handle(req: ChatRequest): Promise<GatewayCallResult> {
    if (sc.latencyMs) await delay(sc.latencyMs);
    const stage = detectStage(req);
    const baseModel = req.model.replace(/:online$/, "");
    const isOnline = req.model.endsWith(":online");

    if (stage === "panel") {
      if (isOnline && sc.panel?.onlineFails) throw new Error(":online variant unsupported");
      const b = sc.panel?.models?.[baseModel] ?? sc.panel?.default ?? { mode: "json" };
      if (b.mode === "throw") throw new Error(b.message ?? `panel ${baseModel} failed`);
      const r: GatewayCallResult = { content: panelContent(baseModel, b), usage: usageOf(b.usage ?? panelUsage), id: `gen-${baseModel}` };
      return r;
    }
    if (stage === "judge" || stage === "repair") {
      const b = (stage === "repair" ? sc.judge?.repair : sc.judge?.first) ?? { mode: "json" };
      if (b.mode === "throw") throw new Error(b.message ?? "judge call failed");
      let content: string;
      if (b.mode === "json") content = JSON.stringify(VALID_ANALYSIS);
      else if (b.mode === "text") content = "Here is my comparison in prose, not JSON. A is best.";
      else if (b.mode === "empty") content = "";
      else content = b.content ?? "";
      return { content, usage: usageOf(judgeUsage), id: `gen-judge-${stage}` };
    }
    // writer / single
    const b = sc.writer ?? { mode: "text" };
    if (b.mode === "throw") throw new Error(b.message ?? "writer call failed");
    let content: string;
    if (b.mode === "empty") content = "";
    else if (b.mode === "raw") content = b.content ?? "";
    else content = b.content ?? "FINAL ANSWER: use SQLite for light agent coordination; Postgres when you need concurrent writers.";
    return { content, usage: usageOf(writerUsage), id: isOnline ? "gen-writer-online" : "gen-writer" };
  }

  const gw: ChatGateway = { chat: (req) => handle(req) };

  if (sc.writer?.stream) {
    gw.streamChat = async function* (req: ChatRequest, _opts?: ChatCallOptions) {
      const final = await handle(req);
      const text = final.content;
      const size = Math.max(1, Math.ceil(text.length / 5));
      for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
      return final;
    };
  }

  if (sc.backfill) {
    gw.getGeneration = async (id: string) => {
      const cost = sc.backfill?.[id];
      return typeof cost === "number" ? { cost } : {};
    };
  }

  return gw;
}

// ---------------------------------------------------------------------------
// Wire deps and run main()
// ---------------------------------------------------------------------------

async function readRealStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function mainEntry(): Promise<void> {
  const sc = loadScenario();
  const gateway = makeFakeGateway(sc);
  const config = await realLoadConfig(); // real config resolution = production-like

  const deps: MainDeps = {
    env: process.env,
    isTTY: process.env.QA_TTY === "1",
    readStdin: readRealStdin,
    runFusionix: (request, opts) => realRunFusionix(request, { ...opts, gateway, config }),
    loadConfig: () => realLoadConfig(),
    loadPrices: async (_apiKey: string, _baseUrl?: string) => {
      if (sc.prices === null) throw new Error("models endpoint unavailable");
      return sc.prices ?? {};
    },
  };

  const code = await main(process.argv.slice(2), deps);
  process.exitCode = code;
}

mainEntry().catch((e: unknown) => {
  process.stderr.write(`qa-harness: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exitCode = 99;
});
