/**
 * Request normalization (spec §6.8).
 *
 * Resolves a single deterministic ExecutionPlan before any gateway call, so the
 * CLI, SDK and hosted API behave identically. Resolution order: deployment
 * defaults → default preset → plugin.preset → explicit overrides → bypass flag
 * → validate.
 */
import { FusionixError } from "./errors.ts";
import { foldRoles, hasUserMessage, userTurnsText } from "./messages.ts";
import { defaultRandomId } from "./util.ts";
import { providerOf, detectCategory, pickBestModel } from "./capabilities.ts";
import type {
  ExecutionPlan,
  FusionixChatCompletionRequest,
  FusionixConfig,
  FusionixPlugin,
  ResolvedPreset,
} from "./types.ts";

const WRITER_STRATEGIES = new Set(["fixed", "top-ranked", "capability"]);
const TOPOLOGIES = new Set(["standard", "debate"]);

/**
 * Apply provider include/exclude filters to a resolved panel (v0.9 §22.1). `only`
 * (when non-empty) keeps only those providers; `exclude` then drops providers.
 * Empty filters are no-ops. Pure.
 */
function filterPanelByProvider(panel: string[], only?: string[], exclude?: string[]): string[] {
  let out = panel;
  const onlySet = new Set((only ?? []).map((p) => p.trim().toLowerCase()).filter((p) => p.length > 0));
  if (onlySet.size > 0) out = out.filter((m) => onlySet.has(providerOf(m).toLowerCase()));
  const exclSet = new Set((exclude ?? []).map((p) => p.trim().toLowerCase()).filter((p) => p.length > 0));
  if (exclSet.size > 0) out = out.filter((m) => !exclSet.has(providerOf(m).toLowerCase()));
  return out;
}

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
  const rawPanel = plugin?.analysis_models ?? preset?.panel ?? [];
  const panel = filterPanelByProvider(rawPanel, plugin?.only_providers, plugin?.exclude_providers);
  const judge = plugin?.model ?? preset?.judge ?? "";
  let writer = isFusionixModel ? (preset?.writer ?? "") : request.model;
  let bypass = plugin?.enabled === false;
  const web = opts.webOverride ?? preset?.web ?? config.defaults.web;
  const maxToolCalls = plugin?.max_tool_calls ?? config.defaults.maxToolCalls;

  // v0.9 extensions (§22): writer strategy and panel topology.
  const writerStrategy = plugin?.writer_strategy ?? preset?.writerStrategy;
  if (writerStrategy !== undefined && !WRITER_STRATEGIES.has(writerStrategy)) {
    throw new FusionixError("invalid_request", `Unknown writer_strategy: ${writerStrategy}`);
  }
  const topology = plugin?.topology ?? preset?.topology;
  if (topology !== undefined && !TOPOLOGIES.has(topology)) {
    throw new FusionixError("invalid_request", `Unknown topology: ${topology}`);
  }

  // Single-model routing (§22.4): fusionix picks the best-fit model from the pool and
  // runs it as a single-model call (bypass mechanics). Resolved here so behavior stays
  // deterministic before any gateway call (§6.8). Only applies to the `fusionix`
  // meta-model: an explicit concrete `model` (writer) or `enabled:false` bypass wins, so
  // a named model is never silently swapped for a routed pick.
  const routing = (plugin?.route === true || preset?.route === true) && !bypass && isFusionixModel;
  let routeCategory: string | undefined;
  if (routing) {
    if (panel.length === 0) {
      throw new FusionixError("invalid_request", "Routing requires a non-empty panel/pool to choose from.");
    }
    // Detect over the user's question only — not caller system/persona text, which is
    // usually fixed across turns and would otherwise pin every query to one category.
    const category = detectCategory(userTurnsText(request.messages));
    const routed = pickBestModel(panel, category);
    if (routed) {
      writer = routed;
      bypass = true;
      routeCategory = category;
    }
  }

  // Model presence (§6.8 step 6). Writer always; panel/judge only when deliberating.
  if (!writer) {
    throw new FusionixError("invalid_request", "No writer model resolved.");
  }
  if (!bypass) {
    if (panel.length === 0) {
      throw new FusionixError(
        "invalid_request",
        rawPanel.length > 0
          ? "Resolved panel is empty after provider filtering."
          : "Resolved panel is empty.",
      );
    }
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
  if (writerStrategy !== undefined && writerStrategy !== "fixed") {
    plan.writerStrategy = writerStrategy as ExecutionPlan["writerStrategy"];
  }
  if (topology !== undefined && topology !== "standard") {
    plan.topology = topology as ExecutionPlan["topology"];
  }
  if (routeCategory !== undefined) plan.routeCategory = routeCategory;

  return plan;
}
