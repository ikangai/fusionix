import test from "node:test";
import assert from "node:assert/strict";
import { resolveRankedModel, resolveRankedIndex, chooseWriter, acceptTopOnConsensus, writerPanelContext } from "../src/pipeline/aggregator.ts";
import type { ExecutionPlan, FusionixAnalysis, PanelResponse } from "../src/types.ts";

const OPUS = "anthropic/claude-opus-4.8";
const GPT = "openai/gpt-5.2";
const GEMINI = "google/gemini-3.1-pro-preview";
const SURVIVORS = [OPUS, GPT, GEMINI];

function analysis(ranking: string[]): FusionixAnalysis {
  return { consensus: [], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [], ranking };
}
function plan(over: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    runId: "r", panel: SURVIVORS, judge: GPT, writer: GPT, web: true, bypass: false, maxToolCalls: 8, messages: [],
    ...over,
  };
}
const ask = (content: string): ExecutionPlan["messages"] => [{ role: "user", content }];

// ---- resolveRankedModel --------------------------------------------------

test("resolveRankedModel matches an exact slug (case-insensitive)", () => {
  assert.equal(resolveRankedModel(GEMINI, SURVIVORS), GEMINI);
  assert.equal(resolveRankedModel("OPENAI/GPT-5.2", SURVIVORS), GPT);
});

test("resolveRankedModel maps a bare or bracketed index to the nth survivor", () => {
  assert.equal(resolveRankedModel("1", SURVIVORS), OPUS);
  assert.equal(resolveRankedModel("[2]", SURVIVORS), GPT);
  assert.equal(resolveRankedModel("4", SURVIVORS), undefined, "out-of-range index");
});

test("resolveRankedModel falls back to a substring/family match, else undefined", () => {
  assert.equal(resolveRankedModel("gemini", SURVIVORS), GEMINI);
  assert.equal(resolveRankedModel(`${GPT}:online`, SURVIVORS), GPT);
  assert.equal(resolveRankedModel("totally unrelated", SURVIVORS), undefined);
  assert.equal(resolveRankedModel("", SURVIVORS), undefined);
});

test("resolveRankedIndex returns the matched position (exact, index, substring, miss)", () => {
  assert.equal(resolveRankedIndex(GEMINI, SURVIVORS), 2);
  assert.equal(resolveRankedIndex("[2]", SURVIVORS), 1);
  assert.equal(resolveRankedIndex("gemini", SURVIVORS), 2);
  assert.equal(resolveRankedIndex("nope", SURVIVORS), undefined);
});

// ---- chooseWriter --------------------------------------------------------

test("chooseWriter 'fixed' (default) returns plan.writer untouched", () => {
  assert.equal(chooseWriter(plan(), analysis([GEMINI, OPUS, GPT]), SURVIVORS), GPT);
});

test("chooseWriter 'top-ranked' returns the judge's #1 surviving model", () => {
  assert.equal(chooseWriter(plan({ writerStrategy: "top-ranked" }), analysis([GEMINI, OPUS, GPT]), SURVIVORS), GEMINI);
});

test("chooseWriter 'top-ranked' skips unresolvable entries, then falls back to plan.writer", () => {
  // First entry unresolvable, second resolves to OPUS.
  assert.equal(chooseWriter(plan({ writerStrategy: "top-ranked" }), analysis(["???", OPUS]), SURVIVORS), OPUS);
  // Nothing resolves → fall back to the configured writer.
  assert.equal(chooseWriter(plan({ writerStrategy: "top-ranked" }), analysis(["???", "!!!"]), SURVIVORS), GPT);
});

test("chooseWriter 'capability' picks the best-fit survivor for the detected category", () => {
  assert.equal(chooseWriter(plan({ writerStrategy: "capability", messages: ask("Prove the theorem") }), analysis([]), SURVIVORS), GPT);
  assert.equal(
    chooseWriter(plan({ writerStrategy: "capability", messages: ask("Explain the chemistry of this enzyme") }), analysis([]), SURVIVORS),
    GEMINI,
  );
});

test("chooseWriter 'capability' classifies the user turn only, ignoring system/persona text", () => {
  // A 'debugging' keyword in a system persona must NOT override a science user question.
  const messages: ExecutionPlan["messages"] = [
    { role: "system", content: "You are a debugging assistant; fix the bug and read the stack trace." },
    { role: "user", content: "Explain the chemistry of this enzyme" },
  ];
  assert.equal(chooseWriter(plan({ writerStrategy: "capability", messages }), analysis([]), SURVIVORS), GEMINI);
});

test("chooseWriter 'capability' keeps plan.writer for a category-less ('general') prompt", () => {
  assert.equal(chooseWriter(plan({ writerStrategy: "capability", messages: ask("tell me a story") }), analysis([]), SURVIVORS), GPT);
});

test("chooseWriter returns plan.writer when there are no survivors", () => {
  assert.equal(chooseWriter(plan({ writerStrategy: "top-ranked" }), analysis([GEMINI]), []), GPT);
});

// ---- acceptTopOnConsensus (§23.1 verifier accept-gate) -------------------

const survivor = (model: string, answer: string): PanelResponse => ({ model, answer });

test("acceptTopOnConsensus returns the judge's #1 survivor on full consensus", () => {
  const survivors = [survivor(OPUS, "a-opus"), survivor(GPT, "a-gpt")];
  assert.equal(acceptTopOnConsensus(analysis([GPT, OPUS]), survivors)?.model, GPT);
});

test("acceptTopOnConsensus falls back to the first survivor when the ranking can't resolve", () => {
  const survivors = [survivor(OPUS, "a"), survivor(GPT, "b")];
  assert.equal(acceptTopOnConsensus(analysis([]), survivors)?.model, OPUS);
  assert.equal(acceptTopOnConsensus(analysis(["nonsense"]), survivors)?.model, OPUS);
});

test("acceptTopOnConsensus does NOT fire when there are contradictions or blind spots", () => {
  const survivors = [survivor(OPUS, "a")];
  const withContra: FusionixAnalysis = { ...analysis([OPUS]), contradictions: [{ topic: "t", stances: [] }] };
  assert.equal(acceptTopOnConsensus(withContra, survivors), undefined);
  const withBlind: FusionixAnalysis = { ...analysis([OPUS]), blindSpots: ["a gap"] };
  assert.equal(acceptTopOnConsensus(withBlind, survivors), undefined);
});

test("acceptTopOnConsensus returns undefined with no survivors", () => {
  assert.equal(acceptTopOnConsensus(analysis([OPUS]), []), undefined);
});

test("acceptTopOnConsensus selects the right duplicate when the judge ranks by index (positional)", () => {
  // A panel may legitimately repeat a model slug; an index ranking must hit the right one.
  const survivors = [survivor("x/a", "first"), survivor("x/b", "mid"), survivor("x/a", "third")];
  assert.equal(acceptTopOnConsensus(analysis(["[3]"]), survivors)?.answer, "third", "[3] → third survivor, not the first x/a");
});

// ---- writerPanelContext (§23.3 access-list) ------------------------------

test("writerPanelContext: 'judge' adds nothing, 'judge+panel' renders all, 'judge+top' renders the top survivor", () => {
  const survivors = [survivor(OPUS, "a-opus"), survivor(GPT, "a-gpt")];
  assert.equal(writerPanelContext(plan(), analysis([]), survivors), undefined);

  const all = writerPanelContext(plan({ writerAccess: "judge+panel" }), analysis([]), survivors) ?? "";
  assert.match(all, /a-opus/);
  assert.match(all, /a-gpt/);

  const top = writerPanelContext(plan({ writerAccess: "judge+top" }), analysis([GPT, OPUS]), survivors) ?? "";
  assert.match(top, /a-gpt/, "top-ranked survivor included");
  assert.doesNotMatch(top, /a-opus/, "non-top survivor excluded");
});

test("writerPanelContext returns undefined for an empty survivor pool", () => {
  assert.equal(writerPanelContext(plan({ writerAccess: "judge+panel" }), analysis([]), []), undefined);
});
