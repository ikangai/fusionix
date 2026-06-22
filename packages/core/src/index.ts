/**
 * @ikangai/fusionix-core — public API.
 *
 * The same core powers the CLI (`--local`), the SDK (`fuseLocal`), and the
 * hosted API. Phase 1 ships request normalization, the panel/judge/writer
 * pipeline, single-model bypass, cost tracking, and result shaping.
 */
export { runFusionix } from "./pipeline/run.ts";
export type { RunFusionixOptions } from "./pipeline/run.ts";

export { loadConfig, redactPreset, listPresetsRedacted } from "./config.ts";
export type { LoadConfigOptions } from "./config.ts";

export { normalizeRequest } from "./normalize.ts";
export type { NormalizeOptions } from "./normalize.ts";

export { aggregateUsage, estimateCost } from "./cost.ts";
export type { AggregatedUsage, CostEstimate, EstimateOptions, PriceEntry } from "./cost.ts";

export { toChatCompletion } from "./result-wire.ts";
export type { ChatCompletionResponse, FusionixExtrasWire, WirePanelEntry, WireAnalysis } from "./result-wire.ts";

export { FusionixError, isFusionixError, FUSIONIX_ERROR_HTTP_STATUS } from "./errors.ts";
export type { FusionixErrorCode, FusionixErrorOptions } from "./errors.ts";

export type { ChatGateway, ChatRequest, ChatCallOptions } from "./gateway/contract.ts";

export { OpenRouterGateway } from "./gateway/openrouter.ts";
export type { GatewayClientOptions, GatewayModel, GenerationCost } from "./gateway/openrouter.ts";

export * from "./types.ts";
