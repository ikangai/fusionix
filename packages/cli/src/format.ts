/** CLI output rendering: markdown, plain text, and OpenAI-compatible JSON (§10.2). */
import { toChatCompletion } from "@ikangai/fusion-core";
import type { FusionAnalysis, FusionRunResult } from "@ikangai/fusion-core";

export interface RenderOptions {
  showAnalysis: boolean;
}

export function footerLine(result: FusionRunResult): string {
  const panelStr = result.panel
    ? result.panel.map((p) => (p.error ? `${p.model} (failed)` : p.model)).join(", ")
    : "single model";
  const cost = result.costUsd == null ? "n/a" : `$${result.costUsd.toFixed(4)}`;
  const dur = `${(result.durationMs / 1000).toFixed(1)}s`;
  return `panel: ${panelStr} · writer: ${result.model} · web: ${result.web} · cost: ${cost} · ${dur} · ${result.runId}`;
}

function nonEmpty<T>(arr: T[] | undefined): arr is T[] {
  return Array.isArray(arr) && arr.length > 0;
}

export function renderAnalysisMarkdown(a: FusionAnalysis): string {
  const out: string[] = ["## Judge analysis"];
  if (nonEmpty(a.consensus)) out.push("**Consensus**\n" + a.consensus.map((c) => `- ${c}`).join("\n"));
  if (nonEmpty(a.contradictions)) {
    out.push(
      "**Contradictions**\n" +
        a.contradictions
          .map((c) => `- **${c.topic}**: ${c.stances.map((s) => `${s.model}: ${s.stance}`).join("; ")}`)
          .join("\n"),
    );
  }
  if (nonEmpty(a.partialCoverage)) {
    out.push("**Partial coverage**\n" + a.partialCoverage.map((p) => `- [${p.models.join(", ")}] ${p.point}`).join("\n"));
  }
  if (nonEmpty(a.uniqueInsights)) {
    out.push("**Unique insights**\n" + a.uniqueInsights.map((u) => `- ${u.model}: ${u.insight}`).join("\n"));
  }
  if (nonEmpty(a.blindSpots)) out.push("**Blind spots**\n" + a.blindSpots.map((b) => `- ${b}`).join("\n"));
  if (nonEmpty(a.ranking)) out.push("**Ranking**\n" + a.ranking.map((r, i) => `${i + 1}. ${r}`).join("\n"));
  return out.join("\n\n");
}

export function renderMarkdown(result: FusionRunResult, opts: RenderOptions): string {
  const parts: string[] = [result.answer.trim()];
  if (opts.showAnalysis && result.analysis) parts.push(renderAnalysisMarkdown(result.analysis));
  parts.push(`---\n\n_${footerLine(result)}_`);
  return parts.join("\n\n") + "\n";
}

export function renderAnalysisText(a: FusionAnalysis): string {
  const lines: string[] = ["Judge analysis:"];
  if (nonEmpty(a.consensus)) lines.push("Consensus: " + a.consensus.join("; "));
  if (nonEmpty(a.contradictions)) lines.push("Contradictions: " + a.contradictions.map((c) => c.topic).join("; "));
  if (nonEmpty(a.partialCoverage)) lines.push("Partial coverage: " + a.partialCoverage.map((p) => p.point).join("; "));
  if (nonEmpty(a.uniqueInsights)) {
    lines.push("Unique insights: " + a.uniqueInsights.map((u) => `${u.model}: ${u.insight}`).join("; "));
  }
  if (nonEmpty(a.blindSpots)) lines.push("Blind spots: " + a.blindSpots.join("; "));
  if (nonEmpty(a.ranking)) lines.push("Ranking: " + a.ranking.join(" > "));
  return lines.join("\n");
}

export function renderText(result: FusionRunResult, opts: RenderOptions): string {
  const parts: string[] = [result.answer.trim()];
  if (opts.showAnalysis && result.analysis) parts.push(renderAnalysisText(result.analysis));
  parts.push(footerLine(result));
  return parts.join("\n\n") + "\n";
}

/** Render analysis (optional) + footer WITHOUT the answer, for the streaming path. */
export function renderExtras(result: FusionRunResult, opts: RenderOptions, format: "md" | "text"): string {
  const parts: string[] = [];
  if (opts.showAnalysis && result.analysis) {
    parts.push(format === "md" ? renderAnalysisMarkdown(result.analysis) : renderAnalysisText(result.analysis));
  }
  parts.push(format === "md" ? `---\n\n_${footerLine(result)}_` : footerLine(result));
  return parts.join("\n\n") + "\n";
}

export function renderJson(result: FusionRunResult): string {
  return JSON.stringify(toChatCompletion(result), null, 2) + "\n";
}
