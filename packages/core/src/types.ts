/**
 * Shared Fusionix types.
 *
 * Two boundaries to keep straight:
 *  - WIRE request (§6.2) uses the OpenRouter/OpenAI shape: snake_case fields.
 *  - Canonical CORE result types below use camelCase (matching the SDK, §9.4).
 *    The wire `fusionix` object (§6.3, snake_case) is produced by an explicit
 *    boundary mapper, not by the pipeline.
 */

// ---------------------------------------------------------------------------
// Wire request (§6.2)
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[] | null;
  name?: string;
}

export interface FusionixPlugin {
  id: "fusionix";
  preset?: string;
  analysis_models?: string[];
  /** Judge model. */
  model?: string;
  /** Advisory in v1 (§15). */
  max_tool_calls?: number;
  enabled?: boolean;
  /** Restrict the resolved panel to these providers, e.g. ["openai","google"] (v0.9 §22.1). */
  only_providers?: string[];
  /** Drop these providers from the resolved panel, e.g. ["anthropic"] (v0.9 §22.1). */
  exclude_providers?: string[];
  /** Writer-selection strategy: "fixed" (default), "top-ranked", or "capability" (v0.9 §22.2). */
  writer_strategy?: string;
  /** Route to a single best-fit model instead of deliberating (v0.9 §22.4). */
  route?: boolean;
  /** Panel coordination topology: "standard" (default) or "debate" (v0.9 §22.5). */
  topology?: string;
}

export interface FusionixChatCompletionRequest {
  /** Writer model, or "fusionix" for the default writer (§6.8). */
  model: string;
  messages: ChatMessage[];
  plugins?: FusionixPlugin[];
  /** Writer only (§6.8). */
  temperature?: number;
  /** Writer only (§6.8). */
  max_tokens?: number;
  stream?: boolean;
}

// ---------------------------------------------------------------------------
// Config + presets
// ---------------------------------------------------------------------------

export interface ResolvedPreset {
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
  /** Writer-selection strategy for this preset (v0.9 §22.2). */
  writerStrategy?: "fixed" | "top-ranked" | "capability";
  /** Panel coordination topology for this preset (v0.9 §22.5). */
  topology?: "standard" | "debate";
  /** When true, this preset routes to a single best-fit model (v0.9 §22.4). */
  route?: boolean;
}

export interface FusionixConfigDefaults {
  maxToolCalls: number;
  web: boolean;
}

export interface FusionixConfig {
  gateway: string;
  defaultPreset?: string;
  defaults: FusionixConfigDefaults;
  presets: Record<string, ResolvedPreset>;
}

/** Redacted preset for the public listing (§5.2). */
export interface RedactedPreset {
  name: string;
  description: string;
  panel_size: number;
  web: boolean;
}

// ---------------------------------------------------------------------------
// Execution plan (output of normalization, §6.8)
// ---------------------------------------------------------------------------

export interface ExecutionPlan {
  runId: string;
  panel: string[];
  judge: string;
  writer: string;
  web: boolean;
  bypass: boolean;
  maxToolCalls: number;
  panelTemperature?: number;
  judgeTemperature?: number;
  writerTemperature?: number;
  panelMaxTokens?: number;
  judgeMaxTokens?: number;
  writerMaxTokens?: number;
  panelSystem?: string;
  judgeSystem?: string;
  writerSystem?: string;
  /** Resolved preset name; carried for Phase-2 run logging (§16). */
  presetName?: string;
  /** Writer-selection strategy (v0.9 §22.2); absent means the fixed `writer`. */
  writerStrategy?: "fixed" | "top-ranked" | "capability";
  /** Panel coordination topology (v0.9 §22.5); absent means "standard". */
  topology?: "standard" | "debate";
  /** Detected query category when the request was routed to a single model (v0.9 §22.4); for logging. */
  routeCategory?: string;
  /** Caller messages, role-folded (developer→system) but otherwise preserved. */
  messages: ChatMessage[];
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export interface GatewayUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** USD, present only when the gateway reports cost (OpenRouter `usage:{include:true}`). */
  cost?: number;
}

export interface GatewayCallResult {
  content: string;
  usage?: GatewayUsage;
  /** Generation id, used for best-effort cost backfill (§8.1). */
  id?: string;
  /** Model echoed by the gateway. */
  model?: string;
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Canonical result (camelCase; SDK §9.3/§9.4)
// ---------------------------------------------------------------------------

export interface Citation {
  title?: string;
  url: string;
}

export interface PanelResponse {
  model: string;
  /** Parsed answer; raw text if JSON parse failed; absent if the member failed. */
  answer?: string;
  assumptions?: string[];
  risks?: string[];
  citations?: Citation[];
  error?: { message: string };
}

export interface Contradiction {
  topic: string;
  stances: { model: string; stance: string }[];
}

export interface PartialCoverage {
  models: string[];
  point: string;
}

export interface UniqueInsight {
  model: string;
  insight: string;
}

export interface FusionixAnalysis {
  consensus: string[];
  contradictions: Contradiction[];
  partialCoverage: PartialCoverage[];
  uniqueInsights: UniqueInsight[];
  blindSpots: string[];
  ranking: string[];
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type WebStatus = "used" | "off" | "unsupported";

export type FusionixStage = "panel" | "debate" | "judge" | "writer";

export interface FusionixRunResult {
  runId: string;
  /** Final synthesized answer (always present on success). */
  answer: string;
  /** Writer model that produced the answer. */
  model: string;
  /** Resolved judge model (deliberation runs only; omitted in single-model bypass). For run logging (§16). */
  judge?: string;
  /** Omitted in single-model bypass mode (§6.7). */
  panel?: PanelResponse[];
  /** Omitted in single-model bypass mode (§6.7). */
  analysis?: FusionixAnalysis;
  usage: Usage;
  /** USD; null when the gateway reports no cost (§8.1). */
  costUsd: number | null;
  durationMs: number;
  web: WebStatus;
  maxToolCallsEnforced: boolean;
  /** Unix seconds, for the OpenAI-compatible `created` field. */
  created: number;
  /** Detected query category when the run was routed to a single model (v0.9 §22.4). */
  routeCategory?: string;
}
