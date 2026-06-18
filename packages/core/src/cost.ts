/**
 * Cost/usage aggregation (spec §8.1).
 *
 * Sums token usage and gateway-reported cost across all calls (panel + judge +
 * writer). `costUsd` is null only when no call reported a cost (§8.1).
 */
import type { GatewayCallResult, Usage } from "./types.ts";

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
