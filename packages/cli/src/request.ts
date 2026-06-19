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

  const request: FusionixChatCompletionRequest = {
    model: args.writer ?? "fusionix",
    messages: [{ role: "user", content: prompt }],
    plugins: [plugin],
  };

  const built: BuiltRequest = { request };
  if (!args.web) built.webOverride = false;
  return built;
}
