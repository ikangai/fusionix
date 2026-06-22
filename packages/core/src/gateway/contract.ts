/**
 * Gateway port (the contract the pipeline depends on).
 *
 * This is the abstraction boundary: pipeline stages and the orchestrator program
 * against `ChatGateway`, never against a concrete adapter. `OpenRouterGateway`
 * (./openrouter.ts) is one implementation; tests inject fakes; alternative
 * gateways (or the hosted API) can supply their own. Keeping the port separate
 * from the adapter is what lets the same core power the CLI, SDK and hosted API.
 */
import type { ChatMessage, GatewayCallResult } from "../types.ts";

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCallOptions {
  signal?: AbortSignal;
}

/** Minimal gateway surface the pipeline stages depend on (lets tests inject fakes). */
export interface ChatGateway {
  chat(req: ChatRequest, opts?: ChatCallOptions): Promise<GatewayCallResult>;
  /** Optional streaming variant; yields content deltas, returns the final result. */
  streamChat?(req: ChatRequest, opts?: ChatCallOptions): AsyncGenerator<string, GatewayCallResult, void>;
  /** Optional best-effort cost lookup for backfill (§8.1). */
  getGeneration?(id: string): Promise<{ cost?: number } | undefined>;
}

/** Build a ChatRequest, including temperature/maxTokens only when defined. */
export function makeChatRequest(
  model: string,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {},
): ChatRequest {
  const req: ChatRequest = { model, messages };
  if (opts.temperature !== undefined) req.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) req.maxTokens = opts.maxTokens;
  return req;
}
