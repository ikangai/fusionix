/**
 * Gateway call with web fallback (spec §15/§17).
 *
 * When web is requested we try the gateway-native `:online` variant. If that
 * call fails (variant unsupported, web routing down, …) we retry once WITHOUT
 * web so a web-availability problem does not surface as a model failure — the
 * run then reports `web: "unsupported"` (§15). A failure of the no-web retry is
 * a genuine model failure and propagates.
 */
import { applyWeb } from "./web.ts";
import { makeChatRequest } from "./contract.ts";
import type { ChatGateway, ChatRequest } from "./contract.ts";
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
  const build = (model: string): ChatRequest =>
    makeChatRequest(model, messages, { temperature: opts.temperature, maxTokens: opts.maxTokens });

  if (!opts.web) {
    return { result: await gateway.chat(build(baseModel), callOpts), usedWeb: false };
  }

  try {
    const result = await gateway.chat(build(applyWeb(baseModel, true)), callOpts);
    return { result, usedWeb: true };
  } catch (err) {
    // A deadline/caller abort is NOT a "web unsupported" signal: don't waste a second
    // round-trip with the same dead signal, and don't let a timeout masquerade as a
    // web fallback (§15/§17). Surface the abort as-is.
    if (opts.signal?.aborted) throw err;
    // Web variant failed — retry once without it (a no-web failure is a real model failure).
    const result = await gateway.chat(build(baseModel), callOpts);
    return { result, usedWeb: false };
  }
}
