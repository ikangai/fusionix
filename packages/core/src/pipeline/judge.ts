/**
 * Judge stage (spec §14.2).
 *
 * Compares the panel answers and returns structured JSON. The writer depends on
 * judge JSON, so EXACTLY ONE repair attempt is allowed: if the first output
 * doesn't parse to an object, the same judge model is asked once to convert it.
 * If that also fails → `judge_failed` (502).
 */
import { FusionixError } from "../errors.ts";
import { extractJson } from "../json.ts";
import { JUDGE_SYSTEM, composeSystem, renderAnswers, renderJudgeUser } from "../prompts.ts";
import { makeChatRequest } from "../gateway/contract.ts";
import type { ChatGateway, ChatRequest } from "../gateway/contract.ts";
import type {
  Contradiction,
  ExecutionPlan,
  FusionixAnalysis,
  GatewayCallResult,
  PanelResponse,
  PartialCoverage,
  UniqueInsight,
} from "../types.ts";

export interface JudgeDeps {
  gateway: ChatGateway;
  signal?: AbortSignal;
}

export interface JudgeOutcome {
  analysis: FusionixAnalysis;
  calls: GatewayCallResult[];
}

const REPAIR_SYSTEM = "You convert text into a single JSON object. Output ONLY the JSON object, with no prose or code fences.";

function extractObject(content: string): Record<string, unknown> | undefined {
  const parsed = extractJson(content);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function coerceContradictions(value: unknown): Contradiction[] {
  if (!Array.isArray(value)) return [];
  const out: Contradiction[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const it = item as { topic?: unknown; stances?: unknown };
    const stances = Array.isArray(it.stances)
      ? it.stances
          .filter((s): s is { model?: unknown; stance?: unknown } => !!s && typeof s === "object")
          .map((s) => ({ model: str(s.model), stance: str(s.stance) }))
      : [];
    out.push({ topic: str(it.topic), stances });
  }
  return out;
}

function coercePartialCoverage(value: unknown): PartialCoverage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((it): it is { models?: unknown; point?: unknown } => !!it && typeof it === "object")
    .map((it) => ({ models: strArray(it.models), point: str(it.point) }));
}

function coerceUniqueInsights(value: unknown): UniqueInsight[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((it): it is { model?: unknown; insight?: unknown } => !!it && typeof it === "object")
    .map((it) => ({ model: str(it.model), insight: str(it.insight) }));
}

/** Map a parsed object (snake_case or camelCase) into the canonical analysis with all 6 arrays. */
export function coerceAnalysis(obj: Record<string, unknown>): FusionixAnalysis {
  return {
    consensus: strArray(obj.consensus),
    contradictions: coerceContradictions(obj.contradictions),
    partialCoverage: coercePartialCoverage(obj.partial_coverage ?? obj.partialCoverage),
    uniqueInsights: coerceUniqueInsights(obj.unique_insights ?? obj.uniqueInsights),
    blindSpots: strArray(obj.blind_spots ?? obj.blindSpots),
    ranking: strArray(obj.ranking),
  };
}

export async function runJudge(
  plan: ExecutionPlan,
  prompt: string,
  panel: PanelResponse[],
  deps: JudgeDeps,
): Promise<JudgeOutcome> {
  const calls: GatewayCallResult[] = [];
  const signalOpts = deps.signal ? { signal: deps.signal } : {};

  const baseReq = (messages: ChatRequest["messages"]): ChatRequest =>
    makeChatRequest(plan.judge, messages, { temperature: plan.judgeTemperature, maxTokens: plan.judgeMaxTokens });

  // Initial judge call. (Judge never uses web.)
  let firstContent: string;
  try {
    const systemText = composeSystem(JUDGE_SYSTEM, plan.judgeSystem);
    const user = renderJudgeUser(prompt, renderAnswers(panel));
    const res = await deps.gateway.chat(
      baseReq([
        { role: "system", content: systemText },
        { role: "user", content: user },
      ]),
      signalOpts,
    );
    calls.push(res);
    firstContent = res.content;
  } catch (cause) {
    throw new FusionixError("judge_failed", "Judge call failed.", { cause, runId: plan.runId });
  }

  const first = extractObject(firstContent);
  if (first) return { analysis: coerceAnalysis(first), calls };

  // Exactly one repair attempt: ask the same model to convert its output to JSON.
  try {
    const repairUser =
      'Convert your previous output into exactly this JSON shape:\n' +
      '{ "consensus": [], "contradictions": [], "partial_coverage": [], "unique_insights": [], "blind_spots": [], "ranking": [] }\n\n' +
      `Previous output:\n${firstContent}`;
    // Repair is a deterministic reformat (not a re-judge), so force temperature 0
    // regardless of the plan's judge temperature.
    const repairReq = makeChatRequest(
      plan.judge,
      [
        { role: "system", content: REPAIR_SYSTEM },
        { role: "user", content: repairUser },
      ],
      { temperature: 0 },
    );
    const res = await deps.gateway.chat(repairReq, signalOpts);
    calls.push(res);
    const repaired = extractObject(res.content);
    if (repaired) return { analysis: coerceAnalysis(repaired), calls };
  } catch (cause) {
    throw new FusionixError("judge_failed", "Judge repair call failed.", { cause, runId: plan.runId });
  }

  throw new FusionixError("judge_failed", "Judge did not return valid JSON after one repair.", { runId: plan.runId });
}
