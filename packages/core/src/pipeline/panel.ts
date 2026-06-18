/**
 * Panel stage (spec §6.3, §14.1, §17).
 *
 * Sends the same prompt to every panel model in parallel. One failure does not
 * fail the run: failed members stay in their resolved position as
 * `{ model, error }`. Panel JSON that fails to parse keeps the raw text as
 * `answer` — there is NO repair call in v1 (§14.1).
 */
import { extractJson } from "../json.ts";
import { prependSystem } from "../messages.ts";
import { PANEL_SYSTEM, composeSystem } from "../prompts.ts";
import { chatWithWebFallback } from "./web-call.ts";
import type { WebCallOptions } from "./web-call.ts";
import type { ChatGateway } from "../gateway/openrouter.ts";
import type { Citation, ExecutionPlan, GatewayCallResult, PanelResponse } from "../types.ts";

export interface PanelDeps {
  gateway: ChatGateway;
  signal?: AbortSignal;
}

export interface PanelOutcome {
  /** One entry per panel model, in resolved order; failures kept in place. */
  responses: PanelResponse[];
  /** Successful gateway calls, for cost aggregation. */
  calls: GatewayCallResult[];
  /** True if the gateway-native web mechanism was actually used by any member (§15). */
  webUsed: boolean;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length > 0 ? out : undefined;
}

function parseCitations(value: unknown): Citation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Citation[] = [];
  for (const item of value) {
    if (item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string") {
      const c = item as { url: string; title?: unknown };
      out.push(typeof c.title === "string" ? { title: c.title, url: c.url } : { url: c.url });
    }
  }
  return out.length > 0 ? out : undefined;
}

function parsePanelContent(model: string, content: string): PanelResponse {
  const parsed = extractJson(content);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const response: PanelResponse = { model };
    response.answer = typeof obj.answer === "string" ? obj.answer : content;
    const assumptions = asStringArray(obj.assumptions);
    if (assumptions) response.assumptions = assumptions;
    const risks = asStringArray(obj.risks);
    if (risks) response.risks = risks;
    const citations = parseCitations(obj.citations);
    if (citations) response.citations = citations;
    return response;
  }
  // Parse failed — keep the raw text as the answer (§14.1, no repair).
  return { model, answer: content };
}

export async function runPanel(plan: ExecutionPlan, deps: PanelDeps): Promise<PanelOutcome> {
  const systemText = composeSystem(PANEL_SYSTEM, plan.panelSystem);
  const messages = prependSystem(systemText, plan.messages);

  const settled = await Promise.all(
    plan.panel.map(async (model) => {
      const webOpts: WebCallOptions = { web: plan.web };
      if (plan.panelTemperature !== undefined) webOpts.temperature = plan.panelTemperature;
      if (plan.panelMaxTokens !== undefined) webOpts.maxTokens = plan.panelMaxTokens;
      if (deps.signal) webOpts.signal = deps.signal;
      try {
        const { result, usedWeb } = await chatWithWebFallback(deps.gateway, model, messages, webOpts);
        return { ok: true as const, model, res: result, usedWeb };
      } catch (err) {
        return { ok: false as const, model, err };
      }
    }),
  );

  const responses: PanelResponse[] = [];
  const calls: GatewayCallResult[] = [];
  let webUsed = false;
  for (const outcome of settled) {
    if (!outcome.ok) {
      responses.push({ model: outcome.model, error: { message: errorMessage(outcome.err) } });
      continue;
    }
    // The call succeeded; count it for cost regardless of content.
    calls.push(outcome.res);
    if (outcome.res.content.trim().length === 0) {
      // An empty body is not a usable answer — treat as a member failure so it
      // does not masquerade as a real panel answer or feed the judge nothing.
      responses.push({ model: outcome.model, error: { message: "Model returned an empty response." } });
      continue;
    }
    responses.push(parsePanelContent(outcome.model, outcome.res.content));
    if (outcome.usedWeb) webUsed = true;
  }
  return { responses, calls, webUsed };
}
