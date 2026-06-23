/** Map parsed CLI args + prompt into a Fusionix wire request (spec §6.2). */
import type { FusionixChatCompletionRequest, FusionixPlugin } from "@ikangai/fusionix-core";
import type { ParsedCliArgs } from "./args.ts";

export interface BuiltRequest {
  request: FusionixChatCompletionRequest;
  /** Forced web setting for --no-web; undefined means "use preset/default". */
  webOverride?: boolean;
}

export function buildRequest(args: ParsedCliArgs, prompt: string): BuiltRequest {
  const plugin: FusionixPlugin = { id: "fusionix" };
  if (args.preset) plugin.preset = args.preset;
  if (args.panel) plugin.analysis_models = args.panel;
  if (args.judge) plugin.model = args.judge;
  if (args.maxToolCalls !== undefined) plugin.max_tool_calls = args.maxToolCalls;
  // v0.9 §22 options.
  if (args.onlyProviders) plugin.only_providers = args.onlyProviders;
  if (args.excludeProviders) plugin.exclude_providers = args.excludeProviders;
  if (args.writerStrategy) plugin.writer_strategy = args.writerStrategy;
  if (args.topology) plugin.topology = args.topology;
  if (args.writerAccess) plugin.writer_access = args.writerAccess;
  if (args.acceptOnConsensus) plugin.accept_on_consensus = true;
  // `--mode fast` is sugar for routing to a single best-fit model (§22.3).
  if (args.route || args.mode === "fast") plugin.route = true;

  const request: FusionixChatCompletionRequest = {
    model: args.writer ?? "fusionix",
    messages: [{ role: "user", content: prompt }],
    plugins: [plugin],
  };

  const built: BuiltRequest = { request };
  if (!args.web) built.webOverride = false;
  return built;
}
