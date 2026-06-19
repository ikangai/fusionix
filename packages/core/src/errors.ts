/**
 * Fusionix error model. Codes and HTTP status mapping per spec §6.6.
 *
 * Core throws `FusionixError`; the hosted API (Phase 2) maps `httpStatus`/`code`
 * onto the OpenAI-shaped error object. The CLI renders `message`.
 */

/** Documented error codes mapped to their HTTP status (§6.6). */
export const FUSIONIX_ERROR_HTTP_STATUS = {
  invalid_request: 400,
  not_a_fusionix_request: 400,
  unauthorized: 401,
  prompt_too_large: 413,
  limit_exceeded: 429,
  all_panel_failed: 502,
  judge_failed: 502,
  writer_failed: 502,
  gateway_error: 502,
  internal_error: 500,
} as const;

export type FusionixErrorCode = keyof typeof FUSIONIX_ERROR_HTTP_STATUS;

const DEFAULT_MESSAGES: Record<FusionixErrorCode, string> = {
  invalid_request: "Invalid request.",
  not_a_fusionix_request: "Not a Fusionix request.",
  unauthorized: "Missing or invalid Fusionix API key.",
  prompt_too_large: "Prompt too large.",
  limit_exceeded: "Per-key limit exceeded.",
  all_panel_failed: "All panel models failed.",
  judge_failed: "Judge failed.",
  writer_failed: "Writer failed or timed out.",
  gateway_error: "Gateway failure.",
  internal_error: "Internal error.",
};

export interface FusionixErrorOptions {
  runId?: string;
  details?: unknown;
  cause?: unknown;
}

export class FusionixError extends Error {
  readonly code: FusionixErrorCode;
  readonly httpStatus: number;
  readonly runId?: string;
  readonly details?: unknown;

  constructor(code: FusionixErrorCode, message?: string, opts: FusionixErrorOptions = {}) {
    super(message ?? DEFAULT_MESSAGES[code], opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "FusionixError";
    this.code = code;
    this.httpStatus = FUSIONIX_ERROR_HTTP_STATUS[code];
    if (opts.runId !== undefined) this.runId = opts.runId;
    if (opts.details !== undefined) this.details = opts.details;
  }
}

export function isFusionixError(value: unknown): value is FusionixError {
  return value instanceof FusionixError;
}
