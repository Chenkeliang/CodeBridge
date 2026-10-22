import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ListSessionsRequest,
  ListSessionsResponse,
} from "@agentclientprotocol/sdk";
import {
  collectAcpSessionHistory,
  collectAcpSessions,
  hasAcpSessionCapability,
  listAcpConfigOptions,
  probeAcpInitialize,
} from "./acp/acp-session-list.js";
import { defaultConfig } from "@codebridge/core";

describe("collectAcpSessions", () => {
  it("includes sessions from the scoped cwd and its child directories", async () => {
    const requests: ListSessionsRequest[] = [];
    const requestPage = async (
      params: ListSessionsRequest,
    ): Promise<ListSessionsResponse> => {
      requests.push(params);
      return {
        sessions: [
          {
            sessionId: "root",
            cwd: path.resolve("/workspace"),
            additionalDirectories: [path.resolve("/shared")],
            title: "root session",
            updatedAt: "2026-07-28T00:00:00.000Z",
          },
          {
            sessionId: "child",
            cwd: path.resolve("/workspace/services/api"),
            title: "child session",
            updatedAt: "2026-07-29T00:00:00.000Z",
          },
          {
            sessionId: "other",
            cwd: path.resolve("/other"),
            title: "other session",
            updatedAt: "2026-07-30T00:00:00.000Z",
          },
        ],
      };
    };

    const sessions = await collectAcpSessions(
      "claude",
      path.resolve("/workspace"),
      requestPage,
    );

    expect(requests).toEqual([{}]);
    expect(sessions.map((session) => session.id)).toEqual(["child", "root"]);
    expect(sessions[1]?.additionalDirectories).toEqual([path.resolve("/shared")]);
  });

  it("follows pagination and sorts all results before applying the limit", async () => {
    const requests: ListSessionsRequest[] = [];
    const requestPage = async (
      params: ListSessionsRequest,
    ): Promise<ListSessionsResponse> => {
      requests.push(params);
      if (!params.cursor) {
        return {
          sessions: [
            {
              sessionId: "old",
              cwd: "/workspace",
              updatedAt: "2026-07-27T00:00:00.000Z",
            },
          ],
          nextCursor: "page-2",
        };
      }
      return {
        sessions: [
          {
            sessionId: "new",
            cwd: "/workspace",
            updatedAt: "2026-07-29T00:00:00.000Z",
          },
          {
            sessionId: "middle",
            cwd: "/workspace",
            updatedAt: "2026-07-28T00:00:00.000Z",
          },
        ],
      };
    };

    const sessions = await collectAcpSessions(
      "codex",
      "/workspace",
      requestPage,
      { all: true, limit: 2 },
    );

    expect(requests).toEqual([{}, { cursor: "page-2" }]);
    expect(sessions.map((session) => session.id)).toEqual(["new", "middle"]);
  });

  it("does not turn ACP request failures into an empty session list", async () => {
    const requestPage = async (): Promise<ListSessionsResponse> => {
      throw new Error("adapter unavailable");
    };

    await expect(
      collectAcpSessions("claude", "/workspace", requestPage),
    ).rejects.toThrow("adapter unavailable");
  });
});

describe("collectAcpSessionHistory", () => {
  it("normalizes user chunks and ACP updates for the Workbench", () => {
    const history = collectAcpSessionHistory([
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "user-1",
          content: { type: "text", text: "查询" },
        },
      },
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "user-1",
          content: { type: "text", text: "会员状态" },
        },
      },
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "agent-1",
          content: { type: "text", text: "结果" },
        },
      },
    ]);

    expect(history).toEqual([
      { kind: "message", text: "查询会员状态" },
      { kind: "agent_event", event: { type: "text_delta", text: "结果", messageId: "agent-1" } },
    ]);
  });

  it("keeps adjacent user messages with different ids separate", () => {
    const history = collectAcpSessionHistory([
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "user-1",
          content: { type: "text", text: "第一条" },
        },
      },
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "user-2",
          content: { type: "text", text: "第二条" },
        },
      },
    ]);

    expect(history).toEqual([
      { kind: "message", text: "第一条" },
      { kind: "message", text: "第二条" },
    ]);
  });
});

describe("ACP session lifecycle capabilities", () => {
  it("gates close/delete from initialize capabilities", () => {
    const response = {
      agentCapabilities: {
        sessionCapabilities: { close: {}, delete: {} },
      },
    };
    expect(hasAcpSessionCapability(response, "close")).toBe(true);
    expect(hasAcpSessionCapability(response, "delete")).toBe(true);
    expect(hasAcpSessionCapability(response, "resume")).toBe(false);
  });
});

describe("probeAcpInitialize", () => {
  it("reports a missing adapter command without crashing the Runner", async () => {
    const profile = {
      ...defaultConfig().backends.claude!,
      acpCommand: "fcb-missing-acp-adapter-for-test",
      acpArgs: [],
    };

    const result = await probeAcpInitialize(profile, process.cwd(), 1_000);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("ENOENT");
  });
});

describe("listAcpConfigOptions", () => {
  it("does not hide adapter failures as an empty capability list", async () => {
    const profile = {
      ...defaultConfig().backends.claude!,
      acpCommand: "fcb-missing-acp-adapter-for-test",
      acpArgs: [],
    };

    await expect(
      listAcpConfigOptions(profile, process.cwd(), 1_000),
    ).rejects.toThrow("ENOENT");
  });
});
