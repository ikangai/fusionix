/**
 * Wire shaping (spec §6.3).
 *
 * Maps the canonical (camelCase) `FusionRunResult` into the OpenAI-compatible
 * `chat.completion` response with the non-standard snake_case `fusion` field.
 * Used by the CLI `--format json` and (Phase 2) the hosted API.
 */
import type {
  Citation,
  FusionAnalysis,
  FusionRunResult,
  PanelResponse,
  Usage,
  WebStatus,
} from "./types.ts";

export interface WirePanelEntry {
  model: string;
  answer?: string;
  assumptions?: string[];
  risks?: string[];
  citations?: Citation[];
  error?: { message: string };
}

export interface WireAnalysis {
  consensus: string[];
  contradictions: { topic: string; stances: { model: string; stance: string }[] }[];
  partial_coverage: { models: string[]; point: string }[];
  unique_insights: { model: string; insight: string }[];
  blind_spots: string[];
  ranking: string[];
}

export interface FusionExtrasWire {
  run_id: string;
  panel?: WirePanelEntry[];
  analysis?: WireAnalysis;
  cost_usd: number | null;
  duration_ms: number;
  web: WebStatus;
  max_tool_calls_enforced: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: { index: number; message: { role: "assistant"; content: string }; finish_reason: "stop" }[];
  usage: Usage;
  fusion: FusionExtrasWire;
}

function toWirePanel(panel: PanelResponse[]): WirePanelEntry[] {
  return panel.map((p) => {
    const entry: WirePanelEntry = { model: p.model };
    if (p.answer !== undefined) entry.answer = p.answer;
    if (p.assumptions) entry.assumptions = p.assumptions;
    if (p.risks) entry.risks = p.risks;
    if (p.citations) entry.citations = p.citations;
    if (p.error) entry.error = p.error;
    return entry;
  });
}

function toWireAnalysis(a: FusionAnalysis): WireAnalysis {
  return {
    consensus: a.consensus,
    contradictions: a.contradictions,
    partial_coverage: a.partialCoverage,
    unique_insights: a.uniqueInsights,
    blind_spots: a.blindSpots,
    ranking: a.ranking,
  };
}

export function toChatCompletion(result: FusionRunResult): ChatCompletionResponse {
  const fusion: FusionExtrasWire = {
    run_id: result.runId,
    cost_usd: result.costUsd,
    duration_ms: result.durationMs,
    web: result.web,
    max_tool_calls_enforced: result.maxToolCallsEnforced,
  };
  if (result.panel) fusion.panel = toWirePanel(result.panel);
  if (result.analysis) fusion.analysis = toWireAnalysis(result.analysis);

  return {
    id: result.runId,
    object: "chat.completion",
    created: result.created,
    model: "fusion",
    choices: [{ index: 0, message: { role: "assistant", content: result.answer }, finish_reason: "stop" }],
    usage: result.usage,
    fusion,
  };
}
