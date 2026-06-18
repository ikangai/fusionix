/** Map parsed CLI args + prompt into a Fusion wire request (spec §6.2). */
import type { FusionChatCompletionRequest, FusionPlugin } from "@ikangai/fusion-core";
import type { ParsedCliArgs } from "./args.ts";

export interface BuiltRequest {
  request: FusionChatCompletionRequest;
  /** Forced web setting for --no-web; undefined means "use preset/default". */
  webOverride?: boolean;
}

export function buildRequest(args: ParsedCliArgs, prompt: string): BuiltRequest {
  const plugin: FusionPlugin = { id: "fusion" };
  if (args.preset) plugin.preset = args.preset;
  if (args.panel) plugin.analysis_models = args.panel;
  if (args.judge) plugin.model = args.judge;
  if (args.maxToolCalls !== undefined) plugin.max_tool_calls = args.maxToolCalls;

  const request: FusionChatCompletionRequest = {
    model: args.writer ?? "fusion",
    messages: [{ role: "user", content: prompt }],
    plugins: [plugin],
  };

  const built: BuiltRequest = { request };
  if (!args.web) built.webOverride = false;
  return built;
}
