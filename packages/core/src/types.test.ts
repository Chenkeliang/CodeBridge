import { describe, expect, it } from "vitest";
import {
  DEFAULT_DATA_DIR,
  parseSessionKey,
  serializeSessionKey,
  type AgentEvent,
} from "./types.js";
import {
  ConfigSchema,
  defaultConfig,
  resolveDefaultAgentId,
  resolveRequireMention,
} from "./config-schema.js";

describe("session key", () => {
  it("roundtrips", () => {
    const key = {
      chatId: "oc_abc",
      topicId: "om_thread",
      backendId: "cursor",
      cwd: "/Users/dev/project",
    };
    const raw = serializeSessionKey(key);
    expect(parseSessionKey(raw)).toEqual(key);
  });

  describe("AgentEvent transport", () => {
    it("preserves block identity and side-effect metadata", () => {
      const events: AgentEvent[] = [
        {
          type: "text_delta",
          blockId: "answer_1",
          messageId: "message_1",
          phase: "final_answer",
          text: "done",
        },
        {
          type: "tool_start",
          toolCallId: "tool_1",
          name: "deploy",
          sideEffects: true,
        },
      ];

      expect(JSON.parse(JSON.stringify(events))).toEqual(events);
    });
  });
});

describe("CodeBridge defaults", () => {
  it("uses the renamed data directory", () => {
    expect(DEFAULT_DATA_DIR).toMatch(/\.codebridge$/);
  });

  it("allows six-hour tasks while keeping no-output and stall watchdogs short", () => {
    const config = ConfigSchema.parse({
      ...defaultConfig(),
      runnerHost: {},
    });

    expect(config.runnerHost?.acpPromptTimeoutMs).toBe(6 * 60 * 60_000);
    expect(config.runnerHost?.acpNoOutputTimeoutMs).toBe(10 * 60_000);
    expect(config.runnerHost?.acpStallTimeoutMs).toBe(30 * 60_000);
  });
});

describe("resolveRequireMention", () => {
  it("uses scenario override", () => {
    const policy = {
      requireMention: true,
      dmMode: "open" as const,
      respondToMentionAll: false,
      scenarios: [
        { name: "trusted", chats: ["oc_trust"], requireMention: false },
      ],
    };
    expect(resolveRequireMention(policy, "oc_trust")).toBe(false);
    expect(resolveRequireMention(policy, "oc_other")).toBe(true);
  });
});

describe("ACP-only backend configuration", () => {
  it("rejects the removed CLI transport", () => {
    expect(() =>
      ConfigSchema.parse({
        feishu: { appId: "app", appSecret: "secret" },
        runner: { token: "runner-token" },
        backends: {
          cursor: {
            type: "cursor-cli",
            transport: "cli",
          },
        },
      }),
    ).toThrow();
  });

  it("does not pin default models or effort to stale values", () => {
    const config = ConfigSchema.parse({
      ...defaultConfig(),
    });

    expect(config.backends.cursor?.model).toBeUndefined();
    expect(config.backends.claude?.model).toBeUndefined();
    expect(config.backends.claude?.effort).toBeUndefined();
    expect(Object.keys(config.backends).sort()).toEqual([
      "claude",
      "codex",
      "cursor",
      "opencode",
      "pi",
    ]);
    expect(config.backends.pi?.type).toBe("pi-sdk");
    expect(config.backends.opencode).toMatchObject({
      type: "generic-spawn",
      acpCommand: "opencode",
      acpArgs: ["acp"],
    });
    expect(config.backends.codex).toMatchObject({
      type: "codex",
      acpCommand: "npx",
      acpArgs: ["-y", "@agentclientprotocol/codex-acp@1.10.0"],
    });
  });

  it("accepts optional Telegram and arbitrary ACP config overrides", () => {
    const config = ConfigSchema.parse({
      ...defaultConfig(),
      telegram: { botToken: "123:token", allowedChats: ["-1001"] },
    });
    expect(config.telegram?.botToken).toBe("123:token");
    expect(config.telegram?.allowedChats).toEqual(["-1001"]);
  });

  it("keeps Project Catalog Git integration explicit and scoped", () => {
    const config = ConfigSchema.parse({
      ...defaultConfig(),
      orchestration: {
        projectCatalog: {
          repositoryPath: "/srv/codebridge-catalog",
          baseRef: "origin/main",
          catalogPath: "catalog/projects.yaml",
        },
      },
    });
    expect(config.orchestration?.projectCatalog).toEqual({
      repositoryPath: "/srv/codebridge-catalog",
      baseRef: "origin/main",
      catalogPath: "catalog/projects.yaml",
    });
  });

  it("bounds the Session queue configuration", () => {
    const config = ConfigSchema.parse({
      ...defaultConfig(),
      orchestration: {
        session: { maxQueuedTurns: 250 },
      },
    });

    expect(config.orchestration?.session?.maxQueuedTurns).toBe(250);
    expect(() => ConfigSchema.parse({
      ...defaultConfig(),
      orchestration: { session: { maxQueuedTurns: 1_001 } },
    })).toThrow();
  });

  it("accepts MCP server configuration without storing credential values", () => {
    const config = ConfigSchema.parse({
      ...defaultConfig(),
      orchestration: {
        mcpServers: {
          logs: {
            transport: "stdio",
            command: "npx",
            args: ["logs-mcp"],
            env: ["LOGS_MCP_TOKEN"],
            revision: "config:1",
          },
          catalog: {
            transport: "http",
            url: "https://mcp.example.test/api",
          },
        },
      },
    });
    expect(config.orchestration?.mcpServers?.logs).toMatchObject({
      command: "npx",
      env: ["LOGS_MCP_TOKEN"],
    });
    expect(config.orchestration?.mcpServers?.catalog.transport).toBe("http");
  });
});

describe("resolveDefaultAgentId", () => {
  it("prefers Web defaultAgent over defaultBackend", () => {
    const config = ConfigSchema.parse({
      ...defaultConfig(),
      defaultAgent: "pi",
      defaultBackend: "cursor",
    });
    expect(resolveDefaultAgentId(config)).toBe("pi");
  });

  it("fills missing supported backends so /backend can switch to all five", () => {
    const config = ConfigSchema.parse({
      ...defaultConfig(),
      backends: {
        cursor: { type: "cursor-cli" },
      },
    });
    expect(config.backends.opencode?.acpCommand).toBe("opencode");
    expect(resolveDefaultAgentId({
      ...config,
      defaultAgent: "opencode",
    })).toBe("opencode");
  });
});
