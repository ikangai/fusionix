import test from "node:test";
import assert from "node:assert/strict";
import {
  contentToString,
  foldRoles,
  findLastUserMessage,
  hasUserMessage,
  renderCompactPrompt,
  prependSystem,
} from "../src/messages.ts";
import type { ChatMessage } from "../src/types.ts";

test("contentToString passes strings through, handles null, flattens content parts", () => {
  assert.equal(contentToString("hi"), "hi");
  assert.equal(contentToString(null), "");
  assert.equal(
    contentToString([
      { type: "text", text: "a" },
      { type: "image_url", image_url: { url: "x" } },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  );
});

test("foldRoles maps developer→system and does not mutate the input", () => {
  const input: ChatMessage[] = [
    { role: "developer", content: "be terse" },
    { role: "user", content: "hi" },
  ];
  const out = foldRoles(input);
  assert.equal(out[0]!.role, "system");
  assert.equal(out[1]!.role, "user");
  assert.equal(input[0]!.role, "developer", "input not mutated");
});

test("findLastUserMessage / hasUserMessage", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: "mid" },
    { role: "user", content: "last" },
  ];
  assert.equal(findLastUserMessage(msgs)?.content, "last");
  assert.equal(hasUserMessage(msgs), true);
  assert.equal(hasUserMessage([{ role: "assistant", content: "x" }]), false);
});

test("renderCompactPrompt returns the bare text for a single user turn", () => {
  assert.equal(renderCompactPrompt([{ role: "user", content: "hello" }]), "hello");
});

test("renderCompactPrompt includes system constraints (developer folded) for a single turn", () => {
  const out = renderCompactPrompt([
    { role: "developer", content: "be terse" },
    { role: "user", content: "hi there" },
  ]);
  assert.equal(out, "System constraints:\nbe terse\n\nUser question:\nhi there");
});

test("renderCompactPrompt renders a multi-turn conversation compactly", () => {
  const out = renderCompactPrompt([
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ]);
  assert.equal(out, "Conversation:\nUser: a\n\nAssistant: b\n\nUser: c");
});

test("prependSystem puts the instruction first and preserves folded caller messages", () => {
  const out = prependSystem("PANEL INSTRUCTION", [
    { role: "system", content: "caller system" },
    { role: "developer", content: "dev note" },
    { role: "user", content: "q" },
  ]);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { role: "system", content: "PANEL INSTRUCTION" });
  assert.equal(out[1]!.role, "system"); // caller system preserved
  assert.equal(out[1]!.content, "caller system");
  assert.equal(out[2]!.role, "system"); // developer folded
  assert.equal(out[3]!.role, "user");
});
