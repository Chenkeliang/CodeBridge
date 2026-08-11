import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "@codebridge/core";

export interface CliSessionSummary {
  id: string;
  backend: string;
  cwd: string;
  additionalDirectories?: string[];
  preview: string;
  updatedAt: string;
}

export type ProviderSessionHistoryEvent =
  | { kind: "message"; text: string }
  | { kind: "agent_event"; event: AgentEvent };

/** Claude Code: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl */
export function encodeClaudeProjectDir(cwd: string): string {
  return path.resolve(cwd).replace(/\//g, "-");
}

export function collectClaudeSessionHistory(entries: unknown[]): ProviderSessionHistoryEvent[] {
  const result: ProviderSessionHistoryEvent[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as {
      type?: unknown;
      uuid?: unknown;
      isMeta?: unknown;
      isSidechain?: unknown;
      message?: { role?: unknown; content?: unknown };
      attachment?: { type?: unknown; names?: unknown; content?: unknown };
    };
    if (value.isMeta === true || value.isSidechain === true) continue;
    if (value.type === "attachment" && value.attachment?.type === "skill_listing") {
      const names = Array.isArray(value.attachment.names)
        ? value.attachment.names.filter((name): name is string => typeof name === "string" && Boolean(name))
        : [];
      const lines = typeof value.attachment.content === "string"
        ? value.attachment.content.split("\n")
        : [];
      if (names.length) {
        result.push({
          kind: "agent_event",
          event: {
            type: "available_commands_update",
            availableCommands: names.map((name) => {
              const prefix = `- ${name}: `;
              const description = lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
              return { name, description: description || "Agent Skill" };
            }),
          },
        });
      }
      continue;
    }
    if (value.type !== "user" && value.type !== "assistant") continue;
    const role = value.message?.role;
    const content = value.message?.content;
    if (role === "assistant") {
      const blocks = Array.isArray(content) ? content : [{ type: "text", text: content }];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        const item = block as {
          type?: unknown;
          text?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
        };
        if (item.type === "text" && typeof item.text === "string" && item.text) {
          result.push({
            kind: "agent_event",
            event: {
              type: "text_delta",
              text: item.text,
              ...(typeof value.uuid === "string" ? { messageId: value.uuid } : {}),
            },
          });
        } else if (item.type === "tool_use" && typeof item.id === "string") {
          result.push({
            kind: "agent_event",
            event: {
              type: "tool_start",
              toolCallId: item.id,
              name: typeof item.name === "string" ? item.name : "tool",
              input: item.input,
            },
          });
        }
      }
      continue;
    }
    if (role !== "user") continue;
    if (typeof content === "string") {
      if (content && !isClaudeInternalUserMessage(content)) result.push({ kind: "message", text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const userText: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const item = block as {
        type?: unknown;
        text?: unknown;
        tool_use_id?: unknown;
        content?: unknown;
        is_error?: unknown;
      };
      if (item.type === "text" && typeof item.text === "string" && !isClaudeInternalUserMessage(item.text)) {
        userText.push(item.text);
      }
      else if (item.type === "tool_result" && typeof item.tool_use_id === "string") {
        result.push({
          kind: "agent_event",
          event: {
            type: "tool_end",
            toolCallId: item.tool_use_id,
            status: item.is_error === true ? "failed" : "completed",
            output: textFromClaudeContent(item.content),
          },
        });
      }
    }
    if (userText.length) result.push({ kind: "message", text: userText.join("") });
  }
  return result;
}

function isClaudeInternalUserMessage(text: string): boolean {
  const normalized = text.trimStart();
  return normalized.startsWith("<command-name>")
    || normalized.startsWith("<local-command-stdout>")
    || normalized.startsWith("<local-command-stderr>");
}

export async function loadClaudeSessionHistory(
  cwd: string,
  sessionId: string,
): Promise<ProviderSessionHistoryEvent[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
    throw new Error(`Invalid Claude session id: ${sessionId}`);
  }
  const file = path.join(
    os.homedir(),
    ".claude",
    "projects",
    encodeClaudeProjectDir(cwd),
    `${sessionId}.jsonl`,
  );
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
  const entries = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
  return collectClaudeSessionHistory(entries);
}

export function collectCodexSessionHistory(entries: unknown[]): ProviderSessionHistoryEvent[] {
  const result: ProviderSessionHistoryEvent[] = [];
  const hasEventUserMessages = entries.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const value = entry as { type?: unknown; payload?: unknown };
    if (value.type !== "event_msg" || !value.payload || typeof value.payload !== "object") return false;
    const payload = value.payload as Record<string, unknown>;
    return payload.type === "user_message" && typeof payload.message === "string";
  });
  const hasEventAgentMessages = entries.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const value = entry as { type?: unknown; payload?: unknown };
    if (value.type !== "event_msg" || !value.payload || typeof value.payload !== "object") return false;
    const payload = value.payload as Record<string, unknown>;
    return payload.type === "agent_message" && typeof payload.message === "string";
  });
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as { type?: unknown; payload?: unknown };
    if (!value.payload || typeof value.payload !== "object") continue;
    const payload = value.payload as Record<string, unknown>;
    if (value.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
      result.push({ kind: "message", text: payload.message });
      continue;
    }
    if (value.type === "event_msg" && payload.type === "agent_message" && typeof payload.message === "string") {
      const phase = payload.phase === "commentary" || payload.phase === "final_answer"
        ? payload.phase
        : undefined;
      result.push({
        kind: "agent_event",
        event: { type: "text_delta", text: payload.message, ...(phase ? { phase } : {}) },
      });
      continue;
    }
    if (value.type !== "response_item") continue;
    if (payload.type === "message" && payload.role === "user" && !hasEventUserMessages) {
      const content = Array.isArray(payload.content) ? payload.content : [];
      const text = content
        .filter((item): item is { type?: unknown; text?: unknown } => Boolean(item && typeof item === "object"))
        .filter((item) => item.type === "input_text" && typeof item.text === "string")
        .map((item) => item.text as string)
        .filter((text) => !isCodexContextMessage(text))
        .join("");
      if (text) result.push({ kind: "message", text });
      continue;
    }
    if (payload.type === "agent_message" && !hasEventAgentMessages) {
      const content = Array.isArray(payload.content) ? payload.content : [];
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const block = item as { type?: unknown; text?: unknown };
        if (block.type !== "input_text" || typeof block.text !== "string" || !block.text) continue;
        result.push({
          kind: "agent_event",
          event: {
            type: "text_delta",
            text: block.text,
            ...(typeof payload.id === "string" ? { messageId: payload.id } : {}),
          },
        });
      }
      continue;
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const toolCallId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      if (!toolCallId) continue;
      let input: unknown = payload.arguments ?? payload.input;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input) as unknown;
        } catch {
          // Keep non-JSON provider input as text.
        }
      }
      result.push({
        kind: "agent_event",
        event: {
          type: "tool_start",
          toolCallId,
          name: typeof payload.name === "string" ? payload.name : "tool",
          input,
        },
      });
      continue;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const toolCallId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      if (!toolCallId) continue;
      result.push({
        kind: "agent_event",
        event: {
          type: "tool_end",
          toolCallId,
          status: "completed",
          output: payload.output,
        },
      });
      continue;
    }
    if (payload.type === "reasoning" && Array.isArray(payload.summary)) {
      for (const item of payload.summary) {
        if (!item || typeof item !== "object") continue;
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string" && text) {
          result.push({ kind: "agent_event", event: { type: "thought_delta", text } });
        }
      }
      continue;
    }
    if (payload.type !== "message" || payload.role !== "assistant" || !Array.isArray(payload.content) || hasEventAgentMessages) continue;
    const phase = payload.phase === "commentary" || payload.phase === "final_answer"
      ? payload.phase
      : undefined;
    for (const item of payload.content) {
      if (!item || typeof item !== "object") continue;
      const block = item as { type?: unknown; text?: unknown };
      if (block.type !== "output_text" || typeof block.text !== "string" || !block.text) continue;
      result.push({
        kind: "agent_event",
        event: {
          type: "text_delta",
          text: block.text,
          ...(typeof payload.id === "string" ? { messageId: payload.id } : {}),
          ...(phase ? { phase } : {}),
        },
      });
    }
  }
  return result;
}

function isCodexContextMessage(text: string): boolean {
  return [
    "# AGENTS.md instructions",
    "<environment_context>",
    "<permissions instructions>",
    "<collaboration_mode>",
    "<plugins_instructions>",
    "<skills_instructions>",
    "Another language model started to solve this problem",
  ].some((prefix) => text.startsWith(prefix));
}

export async function loadCodexSessionHistory(
  sessionId: string,
): Promise<ProviderSessionHistoryEvent[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
    throw new Error(`Invalid Codex session id: ${sessionId}`);
  }
  const file = await findCodexSessionFile(
    path.join(os.homedir(), ".codex", "sessions"),
    sessionId,
  );
  if (!file) throw new Error(`Codex session not found: ${sessionId}`);
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
  const entries = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
  return collectCodexSessionHistory(entries);
}

async function findCodexSessionFile(
  directory: string,
  sessionId: string,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findCodexSessionFile(candidate, sessionId);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) {
      return candidate;
    }
  }
  return undefined;
}

function textFromClaudeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    const block = item as { type?: unknown; text?: unknown };
    return block.type === "text" && typeof block.text === "string" ? block.text : "";
  }).join("");
}
