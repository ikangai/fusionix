/**
 * Wire shaping (spec §6.3).
 *
 * Maps the canonical (camelCase) `FusionixRunResult` into the OpenAI-compatible
 * `chat.completion` response with the non-standard snake_case `fusionix` field.
 * Used by the CLI `--format json` and (Phase 2) the hosted API.
 */
import type {
  Citation,
  FusionixAnalysis,
  FusionixRunResult,
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

export interface FusionixExtrasWire {
  run_id: string;
  panel?: WirePanelEntry[];
  analysis?: WireAnalysis;
  /** Omitted in single-model bypass (§6.7 limits extras to run_id/duration_ms/web). */
  cost_usd?: number | null;
  duration_ms: number;
  web: WebStatus;
  /** Omitted in single-model bypass (§6.7). */
  max_tool_calls_enforced?: boolean;
  /** Present only when the run was routed to a single best-fit model (v0.9 §22.4). */
  route_category?: string;
  /** The model auto-selected by routing; present only for routed runs (v0.9 §22.4). */
  model_used?: string;
  /** True when the writer was skipped on judge consensus (v0.10 §23.1); present only then. */
  accepted_on_consensus?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: { index: number; message: { role: "assistant"; content: string }; finish_reason: string }[];
  usage: Usage;
  fusionix: FusionixExtrasWire;
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

function toWireAnalysis(a: FusionixAnalysis): WireAnalysis {
  return {
    consensus: a.consensus,
    contradictions: a.contradictions,
    partial_coverage: a.partialCoverage,
    unique_insights: a.uniqueInsights,
    blind_spots: a.blindSpots,
    ranking: a.ranking,
  };
}

export function toChatCompletion(result: FusionixRunResult): ChatCompletionResponse {
  // Bypass (§6.7): panel/analysis are absent, and the fusionix extras are limited
  // to run_id, duration_ms and web. Deliberation runs carry the full extras.
  const bypass = !result.panel && !result.analysis;
  const fusionix: FusionixExtrasWire = bypass
    ? { run_id: result.runId, duration_ms: result.durationMs, web: result.web }
    : {
        run_id: result.runId,
        cost_usd: result.costUsd,
        duration_ms: result.durationMs,
        web: result.web,
        max_tool_calls_enforced: result.maxToolCallsEnforced,
      };
  if (result.panel) fusionix.panel = toWirePanel(result.panel);
  if (result.analysis) fusionix.analysis = toWireAnalysis(result.analysis);
  // Routed runs (§22.4) surface the auto-selected model and the detected category.
  if (result.routeCategory !== undefined) {
    fusionix.route_category = result.routeCategory;
    fusionix.model_used = result.model;
  } else if (result.modelSelected) {
    // Adaptive writer (§22.2) or accept-gate (§23.1): the answering model isn't the
    // configured writer, so expose it (consistent with the CLI footer and the run log).
    fusionix.model_used = result.model;
  }
  // Accept-gate runs (§23.1) flag that the writer was skipped on consensus.
  if (result.acceptedOnConsensus) fusionix.accepted_on_consensus = true;

  return {
    id: result.runId,
    object: "chat.completion",
    created: result.created,
    model: "fusionix",
    choices: [{ index: 0, message: { role: "assistant", content: result.answer }, finish_reason: result.finishReason ?? "stop" }],
    usage: result.usage,
    fusionix,
  };
}
