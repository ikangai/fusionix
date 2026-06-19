import test from "node:test";
import assert from "node:assert/strict";
import { FusionixError, isFusionixError, FUSIONIX_ERROR_HTTP_STATUS } from "../src/errors.ts";

test("FusionixError maps each code to its documented HTTP status (§6.6)", () => {
  assert.equal(new FusionixError("invalid_request").httpStatus, 400);
  assert.equal(new FusionixError("not_a_fusionix_request").httpStatus, 400);
  assert.equal(new FusionixError("unauthorized").httpStatus, 401);
  assert.equal(new FusionixError("prompt_too_large").httpStatus, 413);
  assert.equal(new FusionixError("limit_exceeded").httpStatus, 429);
  assert.equal(new FusionixError("all_panel_failed").httpStatus, 502);
  assert.equal(new FusionixError("judge_failed").httpStatus, 502);
  assert.equal(new FusionixError("writer_failed").httpStatus, 502);
  assert.equal(new FusionixError("gateway_error").httpStatus, 502);
  assert.equal(new FusionixError("internal_error").httpStatus, 500);
});

test("FUSIONIX_ERROR_HTTP_STATUS contains every documented code", () => {
  const codes = Object.keys(FUSIONIX_ERROR_HTTP_STATUS);
  for (const c of [
    "invalid_request",
    "not_a_fusionix_request",
    "unauthorized",
    "prompt_too_large",
    "limit_exceeded",
    "all_panel_failed",
    "judge_failed",
    "writer_failed",
    "gateway_error",
    "internal_error",
  ]) {
    assert.ok(codes.includes(c), `missing code ${c}`);
  }
});

test("FusionixError carries code, message, runId and details", () => {
  const err = new FusionixError("judge_failed", "Judge failed.", {
    runId: "fusionix-run-1",
    details: { stage: "judge" },
  });
  assert.equal(err.code, "judge_failed");
  assert.equal(err.message, "Judge failed.");
  assert.equal(err.httpStatus, 502);
  assert.equal(err.runId, "fusionix-run-1");
  assert.deepEqual(err.details, { stage: "judge" });
});

test("FusionixError is a real Error subclass with name set", () => {
  const err = new FusionixError("internal_error");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof FusionixError);
  assert.equal(err.name, "FusionixError");
  assert.ok(err.message.length > 0, "should have a default message");
});

test("FusionixError preserves an underlying cause", () => {
  const cause = new Error("boom");
  const err = new FusionixError("gateway_error", "Gateway failure.", { cause });
  assert.equal(err.cause, cause);
});

test("isFusionixError distinguishes FusionixError from other values", () => {
  assert.equal(isFusionixError(new FusionixError("internal_error")), true);
  assert.equal(isFusionixError(new Error("plain")), false);
  assert.equal(isFusionixError(null), false);
  assert.equal(isFusionixError({ code: "judge_failed" }), false);
});
