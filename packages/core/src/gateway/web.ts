/**
 * Gateway-native web mechanism (spec §15).
 *
 * v1 uses OpenRouter's simplest gateway-native mechanism: the `:online` model
 * variant. We do not implement a custom counted search/fetch loop. `max_tool_calls`
 * is advisory and not enforced by this mechanism (the run reports
 * `max_tool_calls_enforced: false`). `webStatus` maps the per-run outcome to the
 * reported `web` field.
 */
import type { WebStatus } from "../types.ts";

export function applyWeb(model: string, web: boolean): string {
  if (!web) return model;
  if (model.endsWith(":online")) return model;
  return `${model}:online`;
}

/**
 * Map a run's web outcome to its reported status (§15): "off" when web wasn't
 * requested, "used" when the :online mechanism actually served the call(s), and
 * "unsupported" when web was requested but every call fell back to no-web.
 */
export function webStatus(webRequested: boolean, webUsed: boolean): WebStatus {
  if (!webRequested) return "off";
  return webUsed ? "used" : "unsupported";
}
