/**
 * Message handling (spec §14.0).
 *
 * Core preserves caller-provided roles and does not flatten to the last user
 * message. `developer` is folded into `system` for gateways that don't support
 * it. Judge/writer receive a *compact rendering* of the request, not the full
 * transcript.
 */
import type { ChatMessage } from "./types.ts";

/** Coerce message content (string, content-part array, null, or any gateway value) to text. */
export function contentToString(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object") {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") return text;
        }
        return "";
      })
      .filter((t) => t.length > 0)
      .join("\n");
  }
  return "";
}

/** Fold `developer` messages into `system`; otherwise preserve roles. Pure (no mutation). */
export function foldRoles(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => (m.role === "developer" ? { ...m, role: "system" as const } : { ...m }));
}

export function hasUserMessage(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === "user");
}

/**
 * The user's question text only — system/persona and assistant turns excluded.
 * Category detection (routing §22.4 and the capability writer-strategy §22.2) reads
 * this, so fixed persona/system text cannot pin a query to the wrong category.
 */
export function userTurnsText(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => contentToString(m.content))
    .join("\n");
}

/**
 * Render the user request for judge/writer (`{{prompt}}`):
 *  - single user turn, no system → the bare text;
 *  - otherwise → a compact rendering with system constraints + turns.
 */
export function renderCompactPrompt(messages: ChatMessage[]): string {
  const folded = foldRoles(messages);
  const systems = folded
    .filter((m) => m.role === "system")
    .map((m) => contentToString(m.content).trim())
    .filter((s) => s.length > 0);
  const turns = folded.filter((m) => m.role === "user" || m.role === "assistant");
  const users = turns.filter((m) => m.role === "user");

  if (systems.length === 0 && turns.length === 1 && users.length === 1) {
    return contentToString(users[0]!.content).trim();
  }

  const parts: string[] = [];
  if (systems.length > 0) parts.push(`System constraints:\n${systems.join("\n")}`);

  if (turns.length === 1 && users.length === 1) {
    parts.push(`User question:\n${contentToString(users[0]!.content).trim()}`);
  } else if (turns.length > 0) {
    const convo = turns
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${contentToString(m.content).trim()}`)
      .join("\n\n");
    parts.push(`Conversation:\n${convo}`);
  }

  return parts.join("\n\n").trim();
}

/** Prepend an instruction system message, then the role-folded caller messages (§14.0 panel). */
export function prependSystem(systemText: string, messages: ChatMessage[]): ChatMessage[] {
  return [{ role: "system", content: systemText }, ...foldRoles(messages)];
}
