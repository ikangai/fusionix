#!/usr/bin/env node
/** `fusionix` bin entry. Delegates to main() and sets the process exit code. */
import { main } from "./main.ts";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`fusionix: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
