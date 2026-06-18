/** CLI argument parsing (spec §10.2). Pure and testable. */
import { parseArgs } from "node:util";

export type OutputFormat = "text" | "json" | "md";

export interface ParsedCliArgs {
  prompt?: string;
  preset?: string;
  panel?: string[];
  judge?: string;
  writer?: string;
  maxToolCalls?: number;
  web: boolean;
  format?: OutputFormat;
  apiUrl?: string;
  local: boolean;
  stream: boolean;
  showAnalysis: boolean;
  log?: string;
  maxCost?: number;
  version: boolean;
  help: boolean;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      preset: { type: "string" },
      panel: { type: "string" },
      judge: { type: "string" },
      writer: { type: "string" },
      "max-tool-calls": { type: "string" },
      "no-web": { type: "boolean", default: false },
      format: { type: "string" },
      "api-url": { type: "string" },
      local: { type: "boolean", default: false },
      stream: { type: "boolean", default: false },
      "show-analysis": { type: "boolean", default: false },
      log: { type: "string" },
      "max-cost": { type: "string" },
      version: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const args: ParsedCliArgs = {
    web: values["no-web"] ? false : true,
    local: Boolean(values.local),
    stream: Boolean(values.stream),
    showAnalysis: Boolean(values["show-analysis"]),
    version: Boolean(values.version),
    help: Boolean(values.help),
  };

  if (positionals.length > 0) args.prompt = positionals.join(" ");
  if (values.preset) args.preset = values.preset;
  if (values.panel) args.panel = splitCsv(values.panel);
  if (values.judge) args.judge = values.judge;
  if (values.writer) args.writer = values.writer;
  if (values["max-tool-calls"] !== undefined) args.maxToolCalls = Number(values["max-tool-calls"]);
  if (values.format) args.format = values.format as OutputFormat;
  if (values["api-url"]) args.apiUrl = values["api-url"];
  if (values.log) args.log = values.log;
  if (values["max-cost"] !== undefined) args.maxCost = Number(values["max-cost"]);

  return args;
}
