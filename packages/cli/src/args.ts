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
  /** v0.9 §22.1: restrict the panel to these providers. */
  onlyProviders?: string[];
  /** v0.9 §22.1: drop these providers from the panel. */
  excludeProviders?: string[];
  /** v0.9 §22.2: "fixed" | "top-ranked" | "capability". */
  writerStrategy?: string;
  /** v0.9 §22.4: route to a single best-fit model. */
  route: boolean;
  /** v0.9 §22.5 / v0.10 §23.4: "standard" | "debate" | "chain". */
  topology?: string;
  /** v0.9 §22.3: operating point — "fast" | "deliberate". */
  mode?: string;
  /** v0.10 §23.1: accept the top panelist on judge consensus, skipping the writer. */
  acceptOnConsensus: boolean;
  /** v0.10 §23.3: what the writer sees — "judge" | "judge+panel" | "judge+top". */
  writerAccess?: string;
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
      "only-provider": { type: "string" },
      "exclude-provider": { type: "string" },
      "writer-strategy": { type: "string" },
      route: { type: "boolean", default: false },
      topology: { type: "string" },
      mode: { type: "string" },
      "accept-on-consensus": { type: "boolean", default: false },
      "writer-access": { type: "string" },
      version: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const args: ParsedCliArgs = {
    web: values["no-web"] ? false : true,
    local: Boolean(values.local),
    stream: Boolean(values.stream),
    showAnalysis: Boolean(values["show-analysis"]),
    route: Boolean(values.route),
    acceptOnConsensus: Boolean(values["accept-on-consensus"]),
    version: Boolean(values.version),
    help: Boolean(values.help),
  };

  if (positionals.length > 0) args.prompt = positionals.join(" ");
  if (values.preset) args.preset = values.preset;
  if (values.panel) args.panel = splitCsv(values.panel);
  if (values.judge) args.judge = values.judge;
  if (values.writer) args.writer = values.writer;
  if (values["max-tool-calls"] !== undefined) {
    const n = Number(values["max-tool-calls"]);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`invalid --max-tool-calls '${values["max-tool-calls"]}' (expected a positive integer)`);
    }
    args.maxToolCalls = n;
  }
  if (values.format) args.format = values.format as OutputFormat;
  if (values["api-url"]) args.apiUrl = values["api-url"];
  if (values.log) args.log = values.log;
  if (values["max-cost"] !== undefined) {
    const n = Number(values["max-cost"]);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`invalid --max-cost '${values["max-cost"]}' (expected a positive number)`);
    }
    args.maxCost = n;
  }
  if (values["only-provider"]) args.onlyProviders = splitCsv(values["only-provider"]);
  if (values["exclude-provider"]) args.excludeProviders = splitCsv(values["exclude-provider"]);
  if (values["writer-strategy"]) args.writerStrategy = values["writer-strategy"];
  if (values.topology) args.topology = values.topology;
  if (values.mode) args.mode = values.mode;
  if (values["writer-access"]) args.writerAccess = values["writer-access"];

  return args;
}
