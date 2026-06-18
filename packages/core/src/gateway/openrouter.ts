/**
 * OpenRouter gateway client.
 *
 * One responsibility: make OpenAI-compatible chat calls with usage accounting
 * (`usage:{include:true}`, §8.1), plus best-effort `/models` and `/generation`
 * lookups for cost. Non-2xx maps to `gateway_error` (502) without surfacing
 * stored-key state (§6.6).
 */
import { FusionError } from "../errors.ts";
import { contentToString } from "../messages.ts";
import type { ChatMessage, GatewayCallResult, GatewayUsage } from "../types.ts";

export interface GatewayClientOptions {
  apiKey: string;
  baseUrl: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Optional OpenRouter attribution (§13.4). */
  referer?: string;
  title?: string;
  categories?: string;
}

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
}

export interface GatewayModel {
  id: string;
  pricing?: { prompt?: string; completion?: string };
}

export interface GenerationCost {
  cost?: number;
}

function toUsage(raw: unknown): GatewayUsage | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const usage: GatewayUsage = {
    prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
    completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
    total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : 0,
  };
  if (typeof u.cost === "number") usage.cost = u.cost;
  return usage;
}

export class OpenRouterGateway {
  private readonly apiKey: string;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly referer?: string;
  private readonly title?: string;
  private readonly categories?: string;

  constructor(opts: GatewayClientOptions) {
    this.apiKey = opts.apiKey;
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? fetch;
    if (opts.referer) this.referer = opts.referer;
    if (opts.title) this.title = opts.title;
    if (opts.categories) this.categories = opts.categories;
  }

  private headers(): Headers {
    const h = new Headers({
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    });
    if (this.referer) h.set("HTTP-Referer", this.referer);
    if (this.title) {
      h.set("X-OpenRouter-Title", this.title);
      h.set("X-Title", this.title); // legacy fallback
    }
    if (this.categories) h.set("X-OpenRouter-Categories", this.categories);
    return h;
  }

  async chat(req: ChatRequest, opts: ChatCallOptions = {}): Promise<GatewayCallResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: false,
      usage: { include: true },
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

    let res: Response;
    try {
      const init: RequestInit = { method: "POST", headers: this.headers(), body: JSON.stringify(body) };
      if (opts.signal) init.signal = opts.signal;
      res = await this.doFetch(`${this.base}/chat/completions`, init);
    } catch (cause) {
      throw new FusionError("gateway_error", "Gateway request failed.", { cause });
    }

    if (!res.ok) {
      // Do not surface provider auth detail in the message (never reveal stored-key state).
      let detail: unknown;
      try {
        detail = await res.json();
      } catch {
        detail = undefined;
      }
      throw new FusionError("gateway_error", `Gateway request failed (HTTP ${res.status}).`, { details: detail });
    }

    let data: Record<string, unknown>;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch (cause) {
      throw new FusionError("gateway_error", "Gateway returned a non-JSON response.", { cause });
    }

    const choices = data.choices as Array<{ message?: { content?: unknown } }> | undefined;
    const content = contentToString((choices?.[0]?.message?.content ?? "") as string);
    const result: GatewayCallResult = { content, raw: data };
    const usage = toUsage(data.usage);
    if (usage) result.usage = usage;
    if (typeof data.id === "string") result.id = data.id;
    if (typeof data.model === "string") result.model = data.model;
    return result;
  }

  /** Best-effort `/models` lookup for cost estimation (§8.2). Returns undefined on any failure. */
  async listModels(): Promise<GatewayModel[] | undefined> {
    try {
      const res = await this.doFetch(`${this.base}/models`, { headers: this.headers() });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { data?: GatewayModel[] };
      return Array.isArray(data.data) ? data.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Best-effort cost backfill via `/generation` (§8.1). Returns undefined on any failure. */
  async getGeneration(id: string): Promise<GenerationCost | undefined> {
    try {
      const res = await this.doFetch(`${this.base}/generation?id=${encodeURIComponent(id)}`, {
        headers: this.headers(),
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { data?: { total_cost?: number } };
      const cost = data.data?.total_cost;
      return typeof cost === "number" ? { cost } : {};
    } catch {
      return undefined;
    }
  }
}
