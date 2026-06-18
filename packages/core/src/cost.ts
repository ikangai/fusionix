/**
 * Cost/usage aggregation (spec §8.1).
 *
 * Sums token usage and gateway-reported cost across all calls (panel + judge +
 * writer). `costUsd` is null only when no call reported a cost (§8.1).
 */
import type { ExecutionPlan, GatewayCallResult, Usage } from "./types.ts";

export interface AggregatedUsage {
  usage: Usage;
  costUsd: number | null;
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
