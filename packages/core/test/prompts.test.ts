import test from "node:test";
import assert from "node:assert/strict";
import {
  PANEL_SYSTEM,
  JUDGE_SYSTEM,
  JUDGE_RANKING_INSTRUCTION,
  WRITER_SYSTEM,
  composeSystem,
  renderAnswers,
  renderJudgeUser,
  renderWriterUser,
} from "../src/prompts.ts";
import type { PanelResponse } from "../src/types.ts";

test("system prompts carry the §14 instructions and JSON shapes", () => {
  assert.match(PANEL_SYSTEM, /Return JSON/);
  assert.match(PANEL_SYSTEM, /"answer"/);
  assert.match(JUDGE_SYSTEM, /"consensus"/);
  assert.match(JUDGE_SYSTEM, /"blind_spots"/);
  assert.match(JUDGE_SYSTEM, /Do not write the final answer/);
  assert.match(WRITER_SYSTEM, /Lead with the answer/);
  assert.match(WRITER_SYSTEM, /Do not mention the panel/);
});

test("v0.9: the default JUDGE_SYSTEM is the pristine §14.2 prompt; model-id ranking is gated (§22.2)", () => {
  // The default judge prompt is byte-for-byte the pre-v0.9 §14.2 text (pinned to catch drift).
  assert.equal(
    JUDGE_SYSTEM,
    `You compare several model answers to the same user question.
Do not write the final answer. Compare the answers.
Return JSON:
{ "consensus": [], "contradictions": [], "partial_coverage": [], "unique_insights": [], "blind_spots": [], "ranking": [] }`,
  );
  // The model-id ranking instruction lives in a SEPARATE constant, appended only for
  // the top-ranked strategy (judge.ts) — it must NOT be in the default prompt.
  assert.doesNotMatch(JUDGE_SYSTEM, /model-id/);
  assert.match(JUDGE_RANKING_INSTRUCTION, /model-id/);
  // The QA harness routes by the JUDGE_SYSTEM prefix; keep the first line intact.
  assert.ok(JUDGE_SYSTEM.startsWith("You compare several model answers"), "JUDGE_MARK prefix preserved");
});

test("v0.9: the writer prompt resolves disagreements for ALL runs (always-on §22.2)", () => {
  // Pinned to catch drift: WRITER_SYSTEM is an intentional always-on v0.9 change.
  assert.equal(
    WRITER_SYSTEM,
    `Write the final answer to the user's question using the judge analysis.
Rules:
- Lead with the answer.
- Use consensus as high-confidence material.
- When the panel disagrees, resolve it: weigh the evidence, decide which side is correct, and state the resolution — do not merely report that a disagreement exists.
- Preserve useful unique insights.
- Do not mention the panel, judge, or internal process.`,
  );
  assert.ok(WRITER_SYSTEM.startsWith("Write the final answer"), "WRITER_MARK prefix preserved");
});

test("composeSystem appends a preset system prompt when present", () => {
  assert.equal(composeSystem("BASE"), "BASE");
  assert.equal(composeSystem("BASE", "EXTRA"), "BASE\n\nEXTRA");
  assert.equal(composeSystem("BASE", ""), "BASE");
});

test("renderAnswers includes only successful members with their fields", () => {
  const panel: PanelResponse[] = [
    {
      model: "anthropic/claude-opus-4.8",
      answer: "Use SQLite.",
      assumptions: ["single node"],
      risks: ["write contention"],
      citations: [{ title: "Docs", url: "https://example.test" }],
    },
    { model: "openai/gpt-5.2", error: { message: "timeout" } },
  ];
  const out = renderAnswers(panel);
  assert.match(out, /anthropic\/claude-opus-4\.8/);
  assert.match(out, /Use SQLite\./);
  assert.match(out, /single node/);
  assert.match(out, /write contention/);
  assert.match(out, /https:\/\/example\.test/);
  assert.doesNotMatch(out, /openai\/gpt-5\.2/, "failed member excluded");
});

test("renderAnswers includes a member whose answer is raw fallback text", () => {
  const panel: PanelResponse[] = [{ model: "m1", answer: "raw text answer" }];
  assert.match(renderAnswers(panel), /raw text answer/);
});

test("renderJudgeUser and renderWriterUser format with labels", () => {
  const j = renderJudgeUser("What is X?", "ANSWERS_BLOCK");
  assert.match(j, /User question:\nWhat is X\?/);
  assert.match(j, /Answers:\nANSWERS_BLOCK/);

  const w = renderWriterUser("What is X?", '{"consensus":[]}');
  assert.match(w, /User question:\nWhat is X\?/);
  assert.match(w, /Judge analysis:\n\{"consensus":\[\]\}/);
});
