import test from "node:test";
import assert from "node:assert/strict";
import {
  PANEL_SYSTEM,
  JUDGE_SYSTEM,
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

test("v0.9: judge ranks by model-id and writer resolves disagreements (§22.2)", () => {
  // Ranking must be keyed on the model identifier so the adaptive aggregator can map it.
  assert.match(JUDGE_SYSTEM, /model-id/);
  assert.match(JUDGE_SYSTEM, /ranking/);
  // The QA harness routes by the JUDGE_SYSTEM prefix; keep the first line intact.
  assert.ok(JUDGE_SYSTEM.startsWith("You compare several model answers"), "JUDGE_MARK prefix preserved");
  // Writer is instructed to resolve, not merely report, disagreements.
  assert.match(WRITER_SYSTEM, /resolve it/);
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
