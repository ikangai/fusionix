/** Small runtime helpers kept out of the pipeline modules. */
import { randomUUID } from "node:crypto";

/** Generate a run id of the documented shape `fusionix-run-<uuid>` (§6.3). */
export function defaultRandomId(): string {
  return `fusionix-run-${randomUUID()}`;
}
