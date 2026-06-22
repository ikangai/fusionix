/**
 * Cost/usage aggregation (spec §8.1).
 *
 * Sums token usage and gateway-reported cost across all calls (panel + judge +
 * writer). `costUsd` is null only when no call reported a cost (§8.1).
 */
import type { ChatGateway } from "./gateway/contract.ts";
import type { ExecutionPlan, GatewayCallResult, Usage } from "./types.ts";

export interface AggregatedUsage {
  usage: Usage;
  costUsd: number | null;
}

/**
 * Best-effort cost backfill (§8.1). For any call that has a generation id but no
 * reported cost (e.g. a streamed call whose gateway omitted the usage chunk),
 * look the cost up via the gateway's optional `getGeneration`. Never blocks the
 * run; lookup failures are ignored. Mutates the calls' usage in place.
 */
async function backfillCosts(gateway: ChatGateway, calls: GatewayCallResult[]): Promise<void> {
  if (!gateway.getGeneration) return;
  const lookup = gateway.getGeneration.bind(gateway);
  await Promise.all(
    calls.map(async (call) => {
      if (!call.id || (call.usage && typeof call.usage.cost === "number")) return;
      try {
        const gen = await lookup(call.id);
        if (gen && typeof gen.cost === "number") {
          if (call.usage) call.usage.cost = gen.cost;
          else call.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: gen.cost };
        }
      } catch {
        // best-effort; ignore
      }
    }),
  );
}

/**
 * Resolve the final cost of a run: backfill any missing per-call cost, then
 * aggregate tokens + cost across every call (panel + judge + writer, or the
 * single bypass call). The orchestrator calls this instead of sequencing the
 * backfill and aggregation itself.
 */
export async function finalizeCost(gateway: ChatGateway, calls: GatewayCallResult[]): Promise<AggregatedUsage> {
  await backfillCosts(gateway, calls);
  return aggregateUsage(calls);
}

export function aggregateUsage(results: GatewayCallResult[]): AggregatedUsage {
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let cost = 0;
  let anyCost = false;

  for (const r of results) {
    if (!r.usage) continue;
    usage.prompt_tokens += r.usage.prompt_tokens;
    usage.completion_tokens += r.usage.completion_tokens;
    usage.total_tokens += r.usage.total_tokens;
    if (typeof r.usage.cost === "number") {
      cost += r.usage.cost;
      anyCost = true;
    }
  }

  return { usage, costUsd: anyCost ? cost : null };
}

/** Per-token prices in USD. */
export interface PriceEntry {
  prompt: number;
  completion: number;
}

export interface EstimateOptions {
  /** Approx input size; tokens are projected as ceil(chars/4). */
  promptChars?: number;
  /** Assumed completion tokens per stage (rough). */
  completionTokensPerStage?: number;
}

export interface CostEstimate {
  /** Estimated USD across resolved stages; null when no price is known (§8.2). */
  estimateUsd: number | null;
  /** Resolved models with no known price (estimate is incomplete / cannot be enforced). */
  missing: string[];
}

/**
 * Rough pre-flight cost estimate (§8.2). Deliberately approximate: input is
 * projected from prompt length and completions are assumed per stage. When a
 * model's price is unknown it is reported in `missing`; `--max-cost` warns
 * rather than blocking in that case.
 */
export function estimateCost(
  plan: ExecutionPlan,
  prices: Record<string, PriceEntry>,
  opts: EstimateOptions = {},
): CostEstimate {
  const inTokens = Math.ceil((opts.promptChars ?? 0) / 4);
  const comp = opts.completionTokensPerStage ?? 700;
  const missing = new Set<string>();
  let total = 0;
  let known = false;

  const add = (model: string, inputTokens: number): void => {
    const price = prices[model];
    if (!price) {
      missing.add(model);
      return;
    }
    total += inputTokens * price.prompt + comp * price.completion;
    known = true;
  };

  if (plan.bypass) {
    add(plan.writer, inTokens);
  } else {
    for (const m of plan.panel) add(m, inTokens);
    add(plan.judge, inTokens + plan.panel.length * comp); // judge reads the panel answers
    add(plan.writer, inTokens + comp); // writer reads the analysis
  }

  return { estimateUsd: known ? total : null, missing: [...missing] };
}
