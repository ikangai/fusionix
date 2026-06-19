import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, redactPreset, listPresetsRedacted } from "../src/config.ts";

async function emptyDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fusionix-cfg-"));
}

test("loads bundled default config with gateway, defaults and the 6 presets", async () => {
  const dir = await emptyDir();
  const cfg = await loadConfig({ env: {}, cwd: dir });
  assert.equal(cfg.gateway, "https://openrouter.ai/api/v1");
  assert.equal(cfg.defaultPreset, "general-high");
  assert.equal(cfg.defaults.maxToolCalls, 8);
  assert.equal(cfg.defaults.web, true);
  const names = Object.keys(cfg.presets).sort();
  assert.deepEqual(names, [
    "architecture-review",
    "code-review",
    "general-budget",
    "general-high",
    "research-budget",
    "research-high",
  ]);
  assert.equal(cfg.presets["general-high"]!.panel.length, 3);
  assert.ok((cfg.presets["code-review"]!.panelSystem ?? "").length > 0, "domain prompt present");
  await rm(dir, { recursive: true, force: true });
});

test("env FUSIONIX_DEFAULT_GATEWAY and FUSIONIX_DEFAULT_PRESET override the defaults", async () => {
  const dir = await emptyDir();
  const cfg = await loadConfig({
    env: { FUSIONIX_DEFAULT_GATEWAY: "https://example.test/api/v1", FUSIONIX_DEFAULT_PRESET: "research-high" },
    cwd: dir,
  });
  assert.equal(cfg.gateway, "https://example.test/api/v1");
  assert.equal(cfg.defaultPreset, "research-high");
  await rm(dir, { recursive: true, force: true });
});

test("external config file deep-merges presets by key and adds new presets", async () => {
  const dir = await emptyDir();
  const file = join(dir, "fusionix.config.json");
  await writeFile(
    file,
    JSON.stringify({
      gateway: "https://custom.test/api/v1",
      presets: {
        "general-high": { panel: ["m1", "m2"] },
        "custom-preset": { name: "custom-preset", description: "d", panel: ["x"], judge: "j", writer: "w", web: false },
      },
    }),
  );
  const cfg = await loadConfig({ configPath: file, env: {}, cwd: dir });
  assert.equal(cfg.gateway, "https://custom.test/api/v1");
  // panel overridden...
  assert.deepEqual(cfg.presets["general-high"]!.panel, ["m1", "m2"]);
  // ...but the base judge is preserved (deep merge, not replace).
  assert.equal(cfg.presets["general-high"]!.judge, "openai/gpt-5.2");
  assert.equal(cfg.presets["custom-preset"]!.web, false);
  assert.equal(Object.keys(cfg.presets).length, 7);
  await rm(dir, { recursive: true, force: true });
});

test("auto-discovers <cwd>/fusionix.config.json when no explicit path is given", async () => {
  const dir = await emptyDir();
  await writeFile(join(dir, "fusionix.config.json"), JSON.stringify({ defaultPreset: "general-budget" }));
  const cfg = await loadConfig({ env: {}, cwd: dir });
  assert.equal(cfg.defaultPreset, "general-budget");
  await rm(dir, { recursive: true, force: true });
});

test("redactPreset hides model slugs and reports panel_size (§5.2)", async () => {
  const dir = await emptyDir();
  const cfg = await loadConfig({ env: {}, cwd: dir });
  const r = redactPreset(cfg.presets["general-high"]!);
  assert.deepEqual(r, {
    name: "general-high",
    description: cfg.presets["general-high"]!.description,
    panel_size: 3,
    web: true,
  });
  assert.ok(!("panel" in r) && !("judge" in r) && !("writer" in r));
  await rm(dir, { recursive: true, force: true });
});

test("listPresetsRedacted redacts every preset", async () => {
  const dir = await emptyDir();
  const cfg = await loadConfig({ env: {}, cwd: dir });
  const list = listPresetsRedacted(cfg);
  assert.equal(list.length, 6);
  for (const p of list) {
    assert.ok(typeof p.panel_size === "number");
    assert.ok(!("panel" in p));
  }
  await rm(dir, { recursive: true, force: true });
});

test("a brand-new partial preset is created with empty judge/writer (no base to merge)", async () => {
  // Documents the merge-vs-create asymmetry: deep-merge only applies to existing
  // keys; a new partial preset gets empty judge/writer and fails later at use.
  const dir = await emptyDir();
  const file = join(dir, "fusionix.config.json");
  await writeFile(file, JSON.stringify({ presets: { partial: { panel: ["x"] } } }));
  const cfg = await loadConfig({ configPath: file, env: {}, cwd: dir });
  assert.deepEqual(cfg.presets["partial"]!.panel, ["x"]);
  assert.equal(cfg.presets["partial"]!.judge, "");
  assert.equal(cfg.presets["partial"]!.writer, "");
  await rm(dir, { recursive: true, force: true });
});

test("throws fast when defaultPreset points at a missing preset", async () => {
  const dir = await emptyDir();
  await assert.rejects(() => loadConfig({ env: { FUSIONIX_DEFAULT_PRESET: "does-not-exist" }, cwd: dir }));
  await rm(dir, { recursive: true, force: true });
});

test("ignores reserved preset keys like __proto__ (no prototype pollution)", async () => {
  const dir = await emptyDir();
  const file = join(dir, "fusionix.config.json");
  await writeFile(file, '{"presets":{"__proto__":{"panel":["x"],"judge":"j","writer":"w","polluted":true}}}');
  const cfg = await loadConfig({ configPath: file, env: {}, cwd: dir });
  assert.equal(Object.keys(cfg.presets).length, 6, "reserved key not added as a preset");
  assert.ok(!Object.keys(cfg.presets).includes("__proto__"));
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype not polluted");
  await rm(dir, { recursive: true, force: true });
});

test("explicit configPath that does not exist throws", async () => {
  const dir = await emptyDir();
  await assert.rejects(() => loadConfig({ configPath: join(dir, "nope.json"), env: {}, cwd: dir }));
  await rm(dir, { recursive: true, force: true });
});
