import { describe, expect, it } from "vitest";
import {
  collectClaudeSessionHistory,
  collectCodexSessionHistory,
  encodeClaudeProjectDir,
} from "./session-discovery.js";

describe("encodeClaudeProjectDir", () => {
  it("encodes cwd like Claude Code", () => {
    expect(encodeClaudeProjectDir("/Users/dev/proj")).toBe("-Users-dev-proj");
  });
});

describe("collectClaudeSessionHistory", () => {
  it("maps Claude JSONL messages and tool calls in order", () => {
    expect(collectClaudeSessionHistory([
      {
        type: "user",
        isMeta: true,
        message: { role: "user", content: "internal context" },
      },
      { type: "user", uuid: "u1", message: { role: "user", content: "查询会员" } },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "正在查询" },
            { type: "tool_use", id: "t1", name: "equity-center", input: { uid: "1" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "u2",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "会员有效" }],
        },
      },
      {
        type: "assistant",
        isSidechain: true,
        message: { role: "assistant", content: [{ type: "text", text: "subagent result" }] },
      },
    ])).toEqual([
      { kind: "message", text: "查询会员" },
      { kind: "agent_event", event: { type: "text_delta", text: "正在查询", messageId: "a1" } },
      { kind: "agent_event", event: { type: "tool_start", toolCallId: "t1", name: "equity-center", input: { uid: "1" } } },
      { kind: "agent_event", event: { type: "tool_end", toolCallId: "t1", status: "completed", output: "会员有效" } },
    ]);
  });

  it("restores the persisted Claude Skill listing as Agent commands", () => {
    expect(collectClaudeSessionHistory([
      {
        type: "attachment",
        attachment: {
          type: "skill_listing",
          names: ["datamaster", "skill-creator"],
          content: "- datamaster\n- skill-creator: Create and improve Skills",
        },
      },
    ])).toEqual([
      {
        kind: "agent_event",
        event: {
          type: "available_commands_update",
          availableCommands: [
            { name: "datamaster", description: "Agent Skill" },
            { name: "skill-creator", description: "Create and improve Skills" },
          ],
        },
      },
    ]);
  });

  it("does not replay Claude local command bookkeeping as user messages", () => {
    expect(collectClaudeSessionHistory([
      { type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } },
      { type: "user", message: { role: "user", content: "<local-command-stdout>Set model</local-command-stdout>" } },
      { type: "user", message: { role: "user", content: "真正的问题" } },
    ])).toEqual([{ kind: "message", text: "真正的问题" }]);
  });
});

describe("collectCodexSessionHistory", () => {
  it("maps persisted user, assistant, and tool events without prompt context", () => {
    expect(collectCodexSessionHistory([
      {
        type: "response_item",
        payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "# AGENTS.md instructions\ninternal rules" },
            { type: "input_text", text: "<environment_context>internal cwd</environment_context>" },
          ],
        },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "检查项目" }] },
      },
      {
        type: "response_item",
        payload: { type: "function_call", call_id: "call-1", name: "shell", arguments: '{"cmd":"pwd"}' },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-1", output: "/workspace" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          id: "assistant-1",
          content: [{ type: "output_text", text: "检查完成" }],
        },
      },
    ])).toEqual([
      { kind: "message", text: "检查项目" },
      { kind: "agent_event", event: { type: "tool_start", toolCallId: "call-1", name: "shell", input: { cmd: "pwd" } } },
      { kind: "agent_event", event: { type: "tool_end", toolCallId: "call-1", status: "completed", output: "/workspace" } },
      { kind: "agent_event", event: { type: "text_delta", text: "检查完成", messageId: "assistant-1" } },
    ]);
  });

  it("supports legacy Codex agent messages", () => {
    expect(collectCodexSessionHistory([
      { type: "event_msg", payload: { type: "user_message", message: "检查项目" } },
      {
        type: "response_item",
        payload: {
          type: "agent_message",
          id: "legacy-agent-1",
          content: [{ type: "input_text", text: "检查完成" }],
        },
      },
    ])).toEqual([
      { kind: "message", text: "检查项目" },
      { kind: "agent_event", event: { type: "text_delta", text: "检查完成", messageId: "legacy-agent-1" } },
    ]);
  });

  it("uses event messages when legacy Codex stores both agent formats", () => {
    expect(collectCodexSessionHistory([
      { type: "event_msg", payload: { type: "agent_message", message: "正在检查" } },
      {
        type: "response_item",
        payload: {
          type: "agent_message",
          id: "legacy-agent-1",
          content: [{ type: "input_text", text: "正在检查" }],
        },
      },
    ])).toEqual([
      { kind: "agent_event", event: { type: "text_delta", text: "正在检查" } },
    ]);
  });
});
