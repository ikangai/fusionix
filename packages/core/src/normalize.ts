/**
 * Request normalization (spec §6.8).
 *
 * Resolves a single deterministic ExecutionPlan before any gateway call, so the
 * CLI, SDK and hosted API behave identically. Resolution order: deployment
 * defaults → default preset → plugin.preset → explicit overrides → bypass flag
 * → validate.
 */
import { FusionixError } from "./errors.ts";
import { foldRoles, hasUserMessage } from "./messages.ts";
import { defaultRandomId } from "./util.ts";
import type {
  ExecutionPlan,
  FusionixChatCompletionRequest,
  FusionixConfig,
  FusionixPlugin,
  ResolvedPreset,
} from "./types.ts";

export interface NormalizeOptions {
  runId?: string;
  /** Force web on/off (CLI `--no-web`), overriding preset/defaults. */
  webOverride?: boolean;
}

function isPositiveInteger(n: unknown): boolean {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

export function normalizeRequest(
  request: FusionixChatCompletionRequest,
  config: FusionixConfig,
  opts: NormalizeOptions = {},
): ExecutionPlan {
  if (request == null || typeof request !== "object") {
    throw new FusionixError("invalid_request", "Request must be an object.");
  }

  const plugins = Array.isArray(request.plugins) ? request.plugins : [];
  const fusionixPlugins = plugins.filter((p): p is FusionixPlugin => p != null && p.id === "fusionix");

  if (fusionixPlugins.length > 1) {
    throw new FusionixError("invalid_request", "Only one Fusionix plugin is supported per request (v1).");
  }

  const isFusionixModel = request.model === "fusionix";
  const plugin = fusionixPlugins[0];

  // Trigger (§6.8): a Fusionix request iff model === "fusionix" OR a fusionix plugin is present.
  if (!isFusionixModel && plugin === undefined) {
    throw new FusionixError(
      "not_a_fusionix_request",
      "This endpoint requires model 'fusionix' or a fusionix plugin; it is not a single-model proxy.",
    );
  }

  // Shape validation independent of resolution.
  if (request.stream !== undefined && typeof request.stream !== "boolean") {
    throw new FusionixError("invalid_request", "`stream` must be a boolean.");
  }
  if (plugin?.max_tool_calls !== undefined && !isPositiveInteger(plugin.max_tool_calls)) {
    throw new FusionixError("invalid_request", "`max_tool_calls` must be a positive integer.");
  }
  if (plugin?.analysis_models !== undefined && plugin.analysis_models.length === 0) {
    throw new FusionixError("invalid_request", "`analysis_models` must not be empty.");
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new FusionixError("invalid_request", "`messages` must be a non-empty array.");
  }
  if (!hasUserMessage(request.messages)) {
    throw new FusionixError("invalid_request", "At least one user message is required.");
  }

  // Resolve preset: default preset, then plugin.preset.
  let preset: ResolvedPreset | undefined;
  if (config.defaultPreset && config.presets[config.defaultPreset]) {
    preset = config.presets[config.defaultPreset];
  }
  if (plugin?.preset) {
    const named = config.presets[plugin.preset];
    if (!named) throw new FusionixError("invalid_request", `Unknown preset: ${plugin.preset}`);
    preset = named;
  }

  // Resolve stages.
  const panel = plugin?.analysis_models ?? preset?.panel ?? [];
  const judge = plugin?.model ?? preset?.judge ?? "";
  const writer = isFusionixModel ? (preset?.writer ?? "") : request.model;
  const bypass = plugin?.enabled === false;
  const web = opts.webOverride ?? preset?.web ?? config.defaults.web;
  const maxToolCalls = plugin?.max_tool_calls ?? config.defaults.maxToolCalls;

  // Model presence (§6.8 step 6). Writer always; panel/judge only when deliberating.
  if (!writer) {
    throw new FusionixError("invalid_request", "No writer model resolved.");
  }
  if (!bypass) {
    if (panel.length === 0) throw new FusionixError("invalid_request", "Resolved panel is empty.");
    if (!judge) throw new FusionixError("invalid_request", "No judge model resolved.");
  }

  const plan: ExecutionPlan = {
    runId: opts.runId ?? defaultRandomId(),
    panel,
    judge,
    writer,
    web,
    bypass,
    maxToolCalls,
    messages: foldRoles(request.messages),
  };

  if (preset?.temperature !== undefined) {
    plan.panelTemperature = preset.temperature;
    plan.judgeTemperature = preset.temperature;
  }
  const writerTemperature = request.temperature ?? preset?.temperature;
  if (writerTemperature !== undefined) plan.writerTemperature = writerTemperature;
  if (preset?.maxTokens !== undefined) {
    plan.panelMaxTokens = preset.maxTokens;
    plan.judgeMaxTokens = preset.maxTokens;
  }
  const writerMaxTokens = request.max_tokens ?? preset?.maxTokens;
  if (writerMaxTokens !== undefined) plan.writerMaxTokens = writerMaxTokens;
  if (preset?.panelSystem) plan.panelSystem = preset.panelSystem;
  if (preset?.judgeSystem) plan.judgeSystem = preset.judgeSystem;
  if (preset?.writerSystem) plan.writerSystem = preset.writerSystem;
  if (preset?.name) plan.presetName = preset.name;

  return plan;
}
