import test from "node:test";
import assert from "node:assert/strict";
import { defaultRandomId } from "../src/util.ts";

test("defaultRandomId returns a fusionix-run-prefixed unique id", () => {
  const a = defaultRandomId();
  const b = defaultRandomId();
  assert.match(a, /^fusionix-run-/);
  assert.notEqual(a, b);
  assert.ok(a.length > "fusionix-run-".length);
});
