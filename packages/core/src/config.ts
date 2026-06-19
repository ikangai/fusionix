/**
 * Configuration loading and preset redaction.
 *
 * Model slugs are DATA (spec §4): they live in `config/default.config.json`,
 * not in core logic. Resolution order: bundled default → external file
 * (explicit path, `FUSIONIX_CONFIG`, or `<cwd>/fusionix.config.json`) → env
 * overrides (`FUSIONIX_DEFAULT_GATEWAY`, `FUSIONIX_DEFAULT_PRESET`).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FusionixConfig, ResolvedPreset, RedactedPreset } from "./types.ts";
import { FusionixError } from "./errors.ts";

interface RawPreset {
  name?: string;
  description?: string;
  panel?: string[];
  judge?: string;
  writer?: string;
  web?: boolean;
  temperature?: number;
  maxTokens?: number;
  panelSystem?: string;
  judgeSystem?: string;
  writerSystem?: string;
}

interface RawConfig {
  gateway?: string;
  defaultPreset?: string;
  defaults?: { maxToolCalls?: number; web?: boolean };
  presets?: Record<string, RawPreset>;
}

export interface LoadConfigOptions {
  /** Explicit config file path; if set and missing, loadConfig throws. */
  configPath?: string;
  /** Environment map (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Working directory for auto-discovery of fusionix.config.json (defaults to process.cwd()). */
  cwd?: string;
}

const DEFAULT_CONFIG_URL = new URL("../config/default.config.json", import.meta.url);

// Never treat these object keys as preset names (avoids prototype-pollution shapes).
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function toPreset(key: string, raw: RawPreset): ResolvedPreset {
  const preset: ResolvedPreset = {
    name: raw.name ?? key,
    description: raw.description ?? "",
    panel: raw.panel ?? [],
    judge: raw.judge ?? "",
    writer: raw.writer ?? "",
    web: raw.web ?? true,
  };
  if (raw.temperature !== undefined) preset.temperature = raw.temperature;
  if (raw.maxTokens !== undefined) preset.maxTokens = raw.maxTokens;
  if (raw.panelSystem) preset.panelSystem = raw.panelSystem;
  if (raw.judgeSystem) preset.judgeSystem = raw.judgeSystem;
  if (raw.writerSystem) preset.writerSystem = raw.writerSystem;
  return preset;
}

function normalizeConfig(raw: RawConfig): FusionixConfig {
  const presets: Record<string, ResolvedPreset> = {};
  for (const [key, value] of Object.entries(raw.presets ?? {})) {
    if (RESERVED_KEYS.has(key)) continue;
    presets[key] = toPreset(key, value);
  }
  const config: FusionixConfig = {
    gateway: raw.gateway ?? "https://openrouter.ai/api/v1",
    defaults: {
      maxToolCalls: raw.defaults?.maxToolCalls ?? 8,
      web: raw.defaults?.web ?? true,
    },
    presets,
  };
  if (raw.defaultPreset !== undefined) config.defaultPreset = raw.defaultPreset;
  return config;
}

/** Deep-merge an external raw config over an already-normalized config. */
function mergeExternal(base: FusionixConfig, raw: RawConfig): FusionixConfig {
  const merged: FusionixConfig = {
    gateway: raw.gateway ?? base.gateway,
    defaults: {
      maxToolCalls: raw.defaults?.maxToolCalls ?? base.defaults.maxToolCalls,
      web: raw.defaults?.web ?? base.defaults.web,
    },
    presets: { ...base.presets },
  };
  const defaultPreset = raw.defaultPreset ?? base.defaultPreset;
  if (defaultPreset !== undefined) merged.defaultPreset = defaultPreset;

  for (const [key, value] of Object.entries(raw.presets ?? {})) {
    if (RESERVED_KEYS.has(key)) continue;
    const existing = base.presets[key];
    // Deep-merge per preset: external fields win, base fields preserved.
    merged.presets[key] = existing
      ? toPreset(key, { ...presetToRaw(existing), ...value })
      : toPreset(key, value);
  }
  return merged;
}

function presetToRaw(p: ResolvedPreset): RawPreset {
  return { ...p };
}

async function readJsonFile(path: string): Promise<RawConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new FusionixError("internal_error", `Could not read config file: ${path}`, { cause });
  }
  try {
    return JSON.parse(text) as RawConfig;
  } catch (cause) {
    throw new FusionixError("internal_error", `Config file is not valid JSON: ${path}`, { cause });
  }
}

async function readJsonFileIfExists(path: string): Promise<RawConfig | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as RawConfig;
  } catch {
    return undefined;
  }
}

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<FusionixConfig> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const baseRaw = JSON.parse(await readFile(DEFAULT_CONFIG_URL, "utf8")) as RawConfig;
  let config = normalizeConfig(baseRaw);

  // External override file.
  const explicitPath = opts.configPath ?? env.FUSIONIX_CONFIG;
  if (explicitPath) {
    config = mergeExternal(config, await readJsonFile(explicitPath));
  } else {
    const discovered = await readJsonFileIfExists(join(cwd, "fusionix.config.json"));
    if (discovered) config = mergeExternal(config, discovered);
  }

  // Env overrides win last.
  if (env.FUSIONIX_DEFAULT_GATEWAY) config.gateway = env.FUSIONIX_DEFAULT_GATEWAY;
  if (env.FUSIONIX_DEFAULT_PRESET) config.defaultPreset = env.FUSIONIX_DEFAULT_PRESET;

  // Fail fast on a misconfigured default preset instead of surfacing it later as
  // a confusing "resolved panel is empty" at request time.
  if (config.defaultPreset && !config.presets[config.defaultPreset]) {
    throw new FusionixError(
      "internal_error",
      `Configured default preset '${config.defaultPreset}' is not defined in presets.`,
    );
  }

  return config;
}

export function redactPreset(p: ResolvedPreset): RedactedPreset {
  return {
    name: p.name,
    description: p.description,
    panel_size: p.panel.length,
    web: p.web,
  };
}

export function listPresetsRedacted(config: FusionixConfig): RedactedPreset[] {
  return Object.values(config.presets).map(redactPreset);
}
