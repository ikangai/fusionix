/**
 * Gateway call with web fallback (spec §15/§17).
 *
 * When web is requested we try the gateway-native `:online` variant. If that
 * call fails (variant unsupported, web routing down, …) we retry once WITHOUT
 * web so a web-availability problem does not surface as a model failure — the
 * run then reports `web: "unsupported"` (§15). A failure of the no-web retry is
 * a genuine model failure and propagates.
 */
import { applyWeb } from "../gateway/web.ts";
import type { ChatGateway, ChatRequest } from "../gateway/openrouter.ts";
import type { GatewayCallResult } from "../types.ts";

export interface WebCallOptions {
  web: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface WebCallResult {
  result: GatewayCallResult;
  /** Whether the gateway-native web mechanism was actually used for this call. */
  usedWeb: boolean;
}

export async function chatWithWebFallback(
  gateway: ChatGateway,
  baseModel: string,
  messages: ChatRequest["messages"],
  opts: WebCallOptions,
): Promise<WebCallResult> {
  const callOpts = opts.signal ? { signal: opts.signal } : {};
  const build = (model: string): ChatRequest => {
    const req: ChatRequest = { model, messages };
    if (opts.temperature !== undefined) req.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) req.maxTokens = opts.maxTokens;
    return req;
  };

  if (!opts.web) {
    return { result: await gateway.chat(build(baseModel), callOpts), usedWeb: false };
  }

  try {
    const result = await gateway.chat(build(applyWeb(baseModel, true)), callOpts);
    return { result, usedWeb: true };
  } catch {
    // Web variant failed — retry once without it (a no-web failure is a real model failure).
    const result = await gateway.chat(build(baseModel), callOpts);
    return { result, usedWeb: false };
  }
}
