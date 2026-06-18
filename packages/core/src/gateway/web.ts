/**
 * Gateway-native web mechanism (spec §15).
 *
 * v1 uses OpenRouter's simplest gateway-native mechanism: the `:online` model
 * variant. We do not implement a custom counted search/fetch loop. `max_tool_calls`
 * is advisory and not enforced by this mechanism (the run reports
 * `max_tool_calls_enforced: false`).
 */
export function applyWeb(model: string, web: boolean): string {
  if (!web) return model;
  if (model.endsWith(":online")) return model;
  return `${model}:online`;
}
