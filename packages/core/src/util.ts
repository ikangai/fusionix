/** Small runtime helpers kept out of the pipeline modules. */
import { randomUUID } from "node:crypto";

/** Generate a run id of the documented shape `fusion-run-<uuid>` (§6.3). */
export function defaultRandomId(): string {
  return `fusion-run-${randomUUID()}`;
}

/** Current unix time in whole seconds (for the OpenAI-compatible `created` field). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
