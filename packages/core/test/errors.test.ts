import test from "node:test";
import assert from "node:assert/strict";
import { FusionError, isFusionError, FUSION_ERROR_HTTP_STATUS } from "../src/errors.ts";

test("FusionError maps each code to its documented HTTP status (§6.6)", () => {
  assert.equal(new FusionError("invalid_request").httpStatus, 400);
  assert.equal(new FusionError("not_a_fusion_request").httpStatus, 400);
  assert.equal(new FusionError("unauthorized").httpStatus, 401);
  assert.equal(new FusionError("prompt_too_large").httpStatus, 413);
  assert.equal(new FusionError("limit_exceeded").httpStatus, 429);
  assert.equal(new FusionError("all_panel_failed").httpStatus, 502);
  assert.equal(new FusionError("judge_failed").httpStatus, 502);
  assert.equal(new FusionError("writer_failed").httpStatus, 502);
  assert.equal(new FusionError("gateway_error").httpStatus, 502);
  assert.equal(new FusionError("internal_error").httpStatus, 500);
});

test("FUSION_ERROR_HTTP_STATUS contains every documented code", () => {
  const codes = Object.keys(FUSION_ERROR_HTTP_STATUS);
  for (const c of [
    "invalid_request",
    "not_a_fusion_request",
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

test("FusionError carries code, message, runId and details", () => {
  const err = new FusionError("judge_failed", "Judge failed.", {
    runId: "fusion-run-1",
    details: { stage: "judge" },
  });
  assert.equal(err.code, "judge_failed");
  assert.equal(err.message, "Judge failed.");
  assert.equal(err.httpStatus, 502);
  assert.equal(err.runId, "fusion-run-1");
  assert.deepEqual(err.details, { stage: "judge" });
});

test("FusionError is a real Error subclass with name set", () => {
  const err = new FusionError("internal_error");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof FusionError);
  assert.equal(err.name, "FusionError");
  assert.ok(err.message.length > 0, "should have a default message");
});

test("FusionError preserves an underlying cause", () => {
  const cause = new Error("boom");
  const err = new FusionError("gateway_error", "Gateway failure.", { cause });
  assert.equal(err.cause, cause);
});

test("isFusionError distinguishes FusionError from other values", () => {
  assert.equal(isFusionError(new FusionError("internal_error")), true);
  assert.equal(isFusionError(new Error("plain")), false);
  assert.equal(isFusionError(null), false);
  assert.equal(isFusionError({ code: "judge_failed" }), false);
});
