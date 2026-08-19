import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultConfig,
  type BackendConfigOption,
} from "@codebridge/core";
import type { CliSessionSummary } from "@codebridge/runner-client";
import { handleSlashCommand, type SlashContext } from "./slash-commands.js";
import { SLASH_COMMANDS } from "./command-help.js";
import { SessionRouter } from "./session-router.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeSession(id: string, cwd: string, preview: string): CliSessionSummary {
  return { id, backend: "cursor", cwd, preview, updatedAt: "2026-07-07T00:00:00Z" };
}

let chatCounter = 0;

function makeCtx(overrides: {
  scopedSessions: CliSessionSummary[];
  allSessions: CliSessionSummary[];
  resumed?: string[];
  resumeResult?: {
    ok: boolean;
    sessionId?: string;
    busy?: boolean;
    conflict?: boolean;
    error?: string;
  };
  closeSession?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  deleteSession?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  slotContext?: {
    sessionId: string | null;
    activeRunId: string | null;
    providerSessionId: string | null;
  };
  resumedSessions?: string[];
}): SlashContext {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-slash-"));
  tmpDirs.push(dataDir);
  const router = new SessionRouter(dataDir);
  const config = defaultConfig();
  router.initFromConfig(config);
  const resumed = overrides.resumed ?? [];
  const resumedSessions = overrides.resumedSessions ?? [];
  const slotContext = overrides.slotContext ?? {
    sessionId: null,
    activeRunId: null,
    providerSessionId: null,
  };
  // resumeListCache 按 chatId 缓存，每个用例用独立 chatId 避免互相污染
  chatCounter += 1;
  return {
    chatId: `chat-${chatCounter}`,
    senderId: "user1",
    text: "",
    config,
    router,
    listSessions: async (options) =>
      options?.all ? overrides.allSessions : overrides.scopedSessions,
    resumeProviderSession: async (providerSessionId) => {
      resumed.push(providerSessionId);
      const result = overrides.resumeResult ?? {
        ok: true,
        sessionId: `sess_${providerSessionId}`,
      };
      if (result.ok && result.sessionId) {
        resumedSessions.push(result.sessionId);
        // /resume 成功后槽位即绑定该 session。
        slotContext.sessionId = result.sessionId;
      }
      return result;
    },
    getSlotCommandContext: async () => ({ ...slotContext }),
    resumeQueue: async (sessionId) => {
      resumedSessions.push(`resume:${sessionId}`);
      return { queueState: "ready" };
    },
    closeSession: overrides.closeSession,
    deleteSession: overrides.deleteSession,
  };
}

describe("help commands", () => {
  it("returns the compact menu for /help and /menu", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });

    const help = await handleSlashCommand({ ...ctx, text: "/help" });
    const menu = await handleSlashCommand({ ...ctx, text: "/menu" });

    expect(help).toEqual(menu);
    expect(help).toEqual({
      type: "reply",
      text: expect.stringContaining("/resume last"),
    });
    expect((help as { text: string }).text).not.toContain("/session delete");
  });

  it("returns grouped full help for /help full", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });

    const result = await handleSlashCommand({ ...ctx, text: "/help full" });

    expect(result).toEqual({
      type: "reply",
      text: expect.stringContaining("**文件与 Git**"),
    });
    expect((result as { text: string }).text).toContain("/session delete");
    expect((result as { text: string }).text).toContain(
      "/backend <cursor|claude|codex|pi|opencode|default>",
    );
  });

  it("uses plain help rendering when requested by the channel", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });

    const result = await handleSlashCommand({
      ...ctx,
      text: "/help full",
      helpFormat: "plain",
    });

    expect((result as { text: string }).text).not.toMatch(/[`*]/);
  });
});

describe("/session lifecycle", () => {
  it("requires an explicit id for close and delegates it", async () => {
    const closed: string[] = [];
    const ctx = makeCtx({
      scopedSessions: [],
      allSessions: [],
      closeSession: async (id) => {
        closed.push(id);
        return { ok: true };
      },
    });

    await expect(handleSlashCommand({ ...ctx, text: "/session close" })).resolves.toEqual({
      type: "reply",
      text: "用法：`/session close <sessionId>`",
    });
    await expect(
      handleSlashCommand({ ...ctx, text: "/session close s1" }),
    ).resolves.toEqual({
      type: "reply",
      text: "已关闭 ACP session：`s1`",
    });
    expect(closed).toEqual(["s1"]);
  });

  it("rotates the slot generation after closing the bound provider session", async () => {
    const ctx = makeCtx({
      scopedSessions: [],
      allSessions: [],
      closeSession: async () => ({ ok: true }),
      slotContext: {
        sessionId: "sess_bound",
        activeRunId: null,
        providerSessionId: "s1",
      },
    });
    const before = ctx.router.getSlotGeneration(ctx.chatId);

    await expect(
      handleSlashCommand({ ...ctx, text: "/session close s1" }),
    ).resolves.toEqual({
      type: "reply",
      text: "已关闭 ACP session：`s1`\n下一条消息将开启新对话。",
    });
    expect(ctx.router.getSlotGeneration(ctx.chatId)).toBe(before + 1);
  });

  it("does not rotate generation when closing an unbound provider session", async () => {
    const ctx = makeCtx({
      scopedSessions: [],
      allSessions: [],
      closeSession: async () => ({ ok: true }),
      slotContext: {
        sessionId: "sess_bound",
        activeRunId: null,
        providerSessionId: "s-current",
      },
    });
    const before = ctx.router.getSlotGeneration(ctx.chatId);

    await expect(
      handleSlashCommand({ ...ctx, text: "/session close s-other" }),
    ).resolves.toEqual({
      type: "reply",
      text: "已关闭 ACP session：`s-other`",
    });
    expect(ctx.router.getSlotGeneration(ctx.chatId)).toBe(before);
  });

  it("rotates generation after deleting the catalog session id shown in /status", async () => {
    const ctx = makeCtx({
      scopedSessions: [],
      allSessions: [],
      deleteSession: async () => ({ ok: true }),
      slotContext: {
        sessionId: "sess_bound",
        activeRunId: null,
        providerSessionId: "provider-1",
      },
    });
    const before = ctx.router.getSlotGeneration(ctx.chatId);

    await expect(
      handleSlashCommand({ ...ctx, text: "/session delete sess_bound" }),
    ).resolves.toEqual({
      type: "reply",
      text: "已删除 ACP session：`sess_bound`\n下一条消息将开启新对话。",
    });
    expect(ctx.router.getSlotGeneration(ctx.chatId)).toBe(before + 1);
  });

  it("does not rotate generation when close fails", async () => {
    const ctx = makeCtx({
      scopedSessions: [],
      allSessions: [],
      closeSession: async () => ({ ok: false, error: "busy" }),
      slotContext: {
        sessionId: "sess_bound",
        activeRunId: null,
        providerSessionId: "s1",
      },
    });
    const before = ctx.router.getSlotGeneration(ctx.chatId);

    await expect(
      handleSlashCommand({ ...ctx, text: "/session close s1" }),
    ).resolves.toEqual({
      type: "reply",
      text: "关闭 ACP session 失败：busy",
    });
    expect(ctx.router.getSlotGeneration(ctx.chatId)).toBe(before);
  });

  it("deletes an explicit id and reports adapter failures", async () => {
    const ctx = makeCtx({
      scopedSessions: [],
      allSessions: [],
      deleteSession: async () => ({ ok: false, error: "ACP agent 未声明 session/delete 支持" }),
    });

    await expect(
      handleSlashCommand({ ...ctx, text: "/session delete s1" }),
    ).resolves.toEqual({
      type: "reply",
      text: "删除 ACP session 失败：ACP agent 未声明 session/delete 支持",
    });
  });
});

const cursorOptions: BackendConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: "agent",
    values: [
      { value: "agent", name: "Agent" },
      { value: "plan", name: "Plan" },
      { value: "ask", name: "Ask" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "default[]",
    values: [
      { value: "default[]", name: "Auto" },
      { value: "gpt-5.6-sol[reasoning=medium]", name: "gpt-5.6-sol" },
    ],
  },
  {
    id: "telemetry",
    name: "Telemetry",
    type: "boolean",
    currentValue: "false",
    values: [
      { value: "true", name: "On" },
      { value: "false", name: "Off" },
    ],
  },
];

const claudeOptions: BackendConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: "default",
    values: [
      { value: "default", name: "Manual" },
      { value: "bypassPermissions", name: "Bypass Permissions" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "opus[1m]",
    values: [
      { value: "opus[1m]", name: "Opus (1M context)" },
      { value: "sonnet", name: "Sonnet" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    currentValue: "xhigh",
    values: [
      { value: "medium", name: "Medium" },
      { value: "xhigh", name: "Xhigh" },
    ],
  },
];

const codexOptions: BackendConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: "agent",
    values: [
      { value: "read-only", name: "Read-only" },
      { value: "agent", name: "Agent" },
      { value: "agent-full-access", name: "Agent (full access)" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "gpt-5.6-sol",
    values: [
      { value: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
      { value: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    currentValue: "xhigh",
    values: [
      { value: "medium", name: "Medium" },
      { value: "ultra", name: "Ultra" },
    ],
  },
];

function capabilityCtx(
  backendId: "cursor" | "claude" | "codex",
  options: BackendConfigOption[],
): SlashContext {
  const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
  ctx.router.setBinding(ctx.chatId, { backendId });
  ctx.listConfigOptions = async () => options;
  return ctx;
}

describe("live ACP capabilities", () => {
  it("lists live models and resolves display names to adapter values", async () => {
    const ctx = capabilityCtx("cursor", cursorOptions);

    const list = await handleSlashCommand({ ...ctx, text: "/model" });
    expect((list as { text: string }).text).toContain("gpt-5.6-sol");
    expect((list as { text: string }).text).not.toContain("composer-2.5-fast");

    const set = await handleSlashCommand({ ...ctx, text: "/model gpt-5.6-sol" });
    expect((set as { text: string }).text).toContain(
      "gpt-5.6-sol[reasoning=medium]",
    );
    expect(ctx.router.getBinding(ctx.chatId).model).toBe(
      "gpt-5.6-sol[reasoning=medium]",
    );
  });

  it("rejects a model that is absent from the live adapter list", async () => {
    const ctx = capabilityCtx("codex", codexOptions);

    const result = await handleSlashCommand({
      ...ctx,
      text: "/model gpt-5.3-codex",
    });

    expect((result as { text: string }).text).toContain("不在适配器实时列表");
    expect(ctx.router.getBinding(ctx.chatId).model).toBeUndefined();
  });

  it("supports live Codex effort including ultra", async () => {
    const ctx = capabilityCtx("codex", codexOptions);

    const list = await handleSlashCommand({ ...ctx, text: "/effort" });
    expect((list as { text: string }).text).toContain("`ultra`");

    await handleSlashCommand({ ...ctx, text: "/effort ultra" });
    expect(ctx.router.getBinding(ctx.chatId).effort).toBe("ultra");
  });

  it.each([
    ["cursor", cursorOptions, "ask"],
    ["claude", claudeOptions, "bypassPermissions"],
    ["codex", codexOptions, "agent-full-access"],
  ] as const)("uses live %s ACP modes", async (backendId, options, mode) => {
    const ctx = capabilityCtx(backendId, options);

    const list = await handleSlashCommand({ ...ctx, text: "/permission" });
    expect((list as { text: string }).text).toContain(`\`${mode}\``);
    expect((list as { text: string }).text).toContain(
      "Runner approval policy: `auto_allow`",
    );

    await handleSlashCommand({ ...ctx, text: `/permission ${mode}` });
    expect(
      (ctx.router.getBinding(ctx.chatId) as { mode?: string }).mode,
    ).toBe(mode);
  });

  it("shows the effective configured Claude permission mode", async () => {
    const ctx = capabilityCtx("claude", claudeOptions);

    const permission = await handleSlashCommand({
      ...ctx,
      text: "/permission",
    });
    expect((permission as { text: string }).text).toContain(
      "当前会话: `bypassPermissions`",
    );

    const status = await handleSlashCommand({ ...ctx, text: "/status" });
    expect((status as { text: string }).text).toContain(
      "**mode/permission**: bypassPermissions _(配置默认)_",
    );
  });

  it("reports config-option failures without showing stale static models", async () => {
    const ctx = capabilityCtx("claude", claudeOptions);
    ctx.listConfigOptions = async () => {
      throw new Error("adapter unavailable");
    };

    const result = await handleSlashCommand({ ...ctx, text: "/model" });

    expect((result as { text: string }).text).toContain("adapter unavailable");
    expect((result as { text: string }).text).not.toContain("可用 model 示例");
  });

  it("lists and stores arbitrary boolean ACP config options", async () => {
    const ctx = capabilityCtx("cursor", cursorOptions);

    const list = await handleSlashCommand({ ...ctx, text: "/config" });
    expect((list as { text: string }).text).toContain("telemetry");
    expect((list as { text: string }).text).toContain("boolean");

    const set = await handleSlashCommand({ ...ctx, text: "/config telemetry on" });
    expect((set as { text: string }).text).toContain("telemetry");
    expect(
      (ctx.router.getBinding(ctx.chatId) as unknown as {
        acpConfig?: Record<string, string | boolean>;
      }).acpConfig,
    ).toEqual({ telemetry: true });
  });
});

describe("/resume <N> after /resume all", () => {
  it("reports ACP list failures instead of claiming there are no sessions", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
    ctx.listSessions = async () => {
      throw new Error("adapter unavailable");
    };

    const result = await handleSlashCommand({ ...ctx, text: "/resume" });

    expect((result as { text: string }).text).toContain("ACP session 列表读取失败");
    expect((result as { text: string }).text).toContain("adapter unavailable");
    expect((result as { text: string }).text).not.toContain("未找到");
  });

  it("picks from the previously displayed 'all' list, not a fresh scoped query", async () => {
    const scopedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-scoped-"));
    const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-other-"));
    tmpDirs.push(scopedCwd, otherCwd);
    const scoped = [makeSession("scoped-1", scopedCwd, "scoped only")];
    const all = [
      makeSession("go-1", otherCwd, "Meepo Branch Check"),
      makeSession("proj-1", scopedCwd, "Topic Content Info"),
      makeSession("proj-2", scopedCwd, "Test Conversation"),
    ];
    const resumed: string[] = [];
    const ctx = makeCtx({ scopedSessions: scoped, allSessions: all, resumed });

    const listing = await handleSlashCommand({ ...ctx, text: "/resume all" });
    expect(listing?.type).toBe("reply");
    expect((listing as { text: string }).text).toContain("proj-2");

    const picked = await handleSlashCommand({ ...ctx, text: "/resume 1" });
    expect((picked as { text: string }).text).toContain("go-1");
    expect(resumed).toEqual(["go-1"]);
    expect(ctx.router.getBinding(ctx.chatId).cwd).toBe(fs.realpathSync(otherCwd));
  });

  it("restores additionalDirectories advertised by the selected ACP session", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-scoped-"));
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-shared-"));
    tmpDirs.push(cwd, shared);
    const ctx = makeCtx({
      scopedSessions: [
        {
          ...makeSession("s1", cwd, "with roots"),
          additionalDirectories: [shared],
        },
      ],
      allSessions: [],
    });

    const picked = await handleSlashCommand({ ...ctx, text: "/resume 1" });

    expect(ctx.router.getBinding(ctx.chatId).additionalDirectories).toEqual([shared]);
    expect((picked as { text: string }).text).toContain(shared);
  });

  it("without a prior list, falls back to the scoped query", async () => {
    const scoped = [
      makeSession("scoped-1", "/Users/keliang/Projects", "first"),
      makeSession("scoped-2", "/Users/keliang/Projects", "second"),
    ];
    const resumed: string[] = [];
    const ctx = makeCtx({ scopedSessions: scoped, allSessions: [], resumed });

    const picked = await handleSlashCommand({ ...ctx, text: "/resume 2" });
    expect((picked as { text: string }).text).toContain("second");
    expect(resumed).toEqual(["scoped-2"]);
  });

  it("plain /resume caches the scoped list for a later /resume <N>", async () => {
    const scoped = [
      makeSession("scoped-1", "/Users/keliang/Projects", "first"),
      makeSession("scoped-2", "/Users/keliang/Projects", "second"),
    ];
    const resumed: string[] = [];
    const ctx = makeCtx({ scopedSessions: scoped, allSessions: [], resumed });

    await handleSlashCommand({ ...ctx, text: "/resume" });
    const picked = await handleSlashCommand({ ...ctx, text: "/resume 1" });
    expect((picked as { text: string }).text).toContain("first");
    expect(resumed).toEqual(["scoped-1"]);
  });

  it("invalid index reports against the cached list's length", async () => {
    const all = [makeSession("go-1", "/Users/keliang/go", "only one")];
    const ctx = makeCtx({ scopedSessions: [], allSessions: all });

    await handleSlashCommand({ ...ctx, text: "/resume all" });
    const picked = await handleSlashCommand({ ...ctx, text: "/resume 5" });
    expect((picked as { text: string }).text).toContain("共 1 条");
  });

  it("reports provider_session_busy from /resume", async () => {
    const scoped = [makeSession("busy-1", "/Users/keliang/Projects", "busy")];
    const ctx = makeCtx({
      scopedSessions: scoped,
      allSessions: [],
      resumeResult: { ok: false, busy: true, error: "provider_session_busy" },
    });

    const picked = await handleSlashCommand({ ...ctx, text: "/resume 1" });
    expect((picked as { text: string }).text).toContain("正被其他任务占用");
  });

  it("bumps the slot generation once when the slot is bound to another session", async () => {
    const scoped = [makeSession("conflict-1", "/Users/keliang/Projects", "conflict")];
    let calls = 0;
    const ctx = makeCtx({ scopedSessions: scoped, allSessions: [] });
    ctx.resumeProviderSession = async (providerSessionId) => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, conflict: true, error: "slot_already_bound" };
      }
      return { ok: true, sessionId: `sess_${providerSessionId}` };
    };
    const before = ctx.router.getSlotGeneration(ctx.chatId);

    const picked = await handleSlashCommand({ ...ctx, text: "/resume 1" });
    expect((picked as { text: string }).text).toContain("provider session");
    expect(calls).toBe(2);
    expect(ctx.router.getSlotGeneration(ctx.chatId)).toBe(before + 1);
  });

  it("does not resume a session whose working directory no longer exists", async () => {
    const missing = path.join(os.tmpdir(), "fcb-missing-resume-directory");
    const resumed: string[] = [];
    const ctx = makeCtx({
      scopedSessions: [],
      allSessions: [makeSession("missing-1", missing, "gone")],
      resumed,
    });
    const before = ctx.router.getBinding(ctx.chatId).cwd;

    await handleSlashCommand({ ...ctx, text: "/resume all" });
    const picked = await handleSlashCommand({ ...ctx, text: "/resume 1" });

    expect((picked as { text: string }).text).toContain("不存在");
    expect(resumed).toEqual([]);
    expect(ctx.router.getBinding(ctx.chatId).cwd).toBe(before);
  });
});

describe("/cd working-directory validation", () => {
  it("rejects relative paths without changing the binding", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
    const before = ctx.router.getBinding(ctx.chatId).cwd;

    const result = await handleSlashCommand({ ...ctx, text: "/cd mypy" });

    expect((result as { text: string }).text).toContain("绝对路径");
    expect(ctx.router.getBinding(ctx.chatId).cwd).toBe(before);
  });

  it("rejects missing directories without changing the binding", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
    const before = ctx.router.getBinding(ctx.chatId).cwd;
    const missing = path.join(os.tmpdir(), "fcb-directory-that-does-not-exist");

    const result = await handleSlashCommand({
      ...ctx,
      text: `/cd ${missing}`,
    });

    expect((result as { text: string }).text).toContain("不存在");
    expect(ctx.router.getBinding(ctx.chatId).cwd).toBe(before);
  });

  it("stores the canonical path for an existing directory", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-cwd-target-"));
    const link = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "fcb-cwd-link-")),
      "project",
    );
    tmpDirs.push(target, path.dirname(link));
    fs.symlinkSync(target, link);

    const result = await handleSlashCommand({ ...ctx, text: `/cd ${link}` });

    expect((result as { text: string }).text).toContain(fs.realpathSync(target));
    expect(ctx.router.getBinding(ctx.chatId).cwd).toBe(fs.realpathSync(target));
  });
});

describe("/root additional directories", () => {
  it("adds, lists, and removes a canonical additional directory", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-root-target-"));
    tmpDirs.push(target);

    const added = await handleSlashCommand({
      ...ctx,
      text: `/root add ${target}`,
    });
    expect((added as { text: string }).text).toContain(fs.realpathSync(target));
    expect(ctx.router.getBinding(ctx.chatId).additionalDirectories).toEqual([
      fs.realpathSync(target),
    ]);
    const status = await handleSlashCommand({ ...ctx, text: "/status" });
    expect((status as { text: string }).text).toContain(
      `**additionalDirectories**: ${fs.realpathSync(target)}`,
    );

    const listed = await handleSlashCommand({ ...ctx, text: "/roots" });
    expect((listed as { text: string }).text).toContain(fs.realpathSync(target));

    const removed = await handleSlashCommand({
      ...ctx,
      text: `/root remove ${target}`,
    });
    expect((removed as { text: string }).text).toContain("已移除");
    expect(ctx.router.getBinding(ctx.chatId).additionalDirectories).toEqual([]);
  });

  it("rejects relative and missing additional directories", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
    const relative = await handleSlashCommand({
      ...ctx,
      text: "/root add shared",
    });
    expect((relative as { text: string }).text).toContain("绝对路径");

    const missing = path.join(os.tmpdir(), "fcb-root-missing");
    const result = await handleSlashCommand({
      ...ctx,
      text: `/root add ${missing}`,
    });
    expect((result as { text: string }).text).toContain("不存在");
    expect(ctx.router.getBinding(ctx.chatId).additionalDirectories).toBeUndefined();
  });

  it("asks Runner to access a newly added directory so macOS can grant TCC", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-root-auth-"));
    tmpDirs.push(target);
    const requested: string[] = [];
    (
      ctx as SlashContext & {
        authorizeDirectory: (
          directory: string,
        ) => Promise<{ ok: boolean; path?: string }>;
      }
    ).authorizeDirectory = async (directory) => {
      requested.push(directory);
      return { ok: true, path: fs.realpathSync(directory) };
    };

    const result = await handleSlashCommand({
      ...ctx,
      text: `/root add ${target}`,
    });

    expect(requested).toEqual([target]);
    expect((result as { text: string }).text).toContain("Runner 已验证目录访问权限");
  });

  it("notifies the chat before waiting for macOS directory authorization", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
    const target = "/mock/tcc-project";
    const events: string[] = [];
    (
      ctx as SlashContext & {
        notifyStatus: (text: string) => Promise<void>;
      }
    ).notifyStatus = async (text) => {
      expect(text).toContain("macOS");
      events.push("notified");
    };
    ctx.authorizeDirectory = async (directory) => {
      events.push("authorize");
      return { ok: true, path: directory };
    };

    await handleSlashCommand({ ...ctx, text: `/root add ${target}` });

    expect(events).toEqual(["notified", "authorize"]);
  });

  it("lets Runner authorize a protected directory before Bridge filesystem access", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
    const target = "/mock/protected-project";
    ctx.authorizeDirectory = async (directory) => ({
      ok: true,
      path: directory,
    });

    const result = await handleSlashCommand({
      ...ctx,
      text: `/root add ${target}`,
    });

    expect((result as { text: string }).text).toContain("Runner 已验证目录访问权限");
    expect(ctx.router.getBinding(ctx.chatId).additionalDirectories).toEqual([
      target,
    ]);
  });
});

describe("/steer", () => {
  it("forwards an in-flight steering prompt to Runner by runId", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
    ctx.getSlotCommandContext = async () => ({
      sessionId: "sess_1",
      activeRunId: "run_1",
      providerSessionId: null,
    });
    const steered: Array<{ runId: string; prompt: string }> = [];
    ctx.steerActiveRun = async (runId, prompt) => {
      steered.push({ runId, prompt });
      return { ok: true, outcome: "injected" };
    };

    const result = await handleSlashCommand({
      ...ctx,
      text: "/steer focus on tests",
    });
    expect((result as { text: string }).text).toContain("injected");
    expect(steered).toEqual([{ runId: "run_1", prompt: "focus on tests" }]);
  });
});

describe("/ws use working-directory validation", () => {
  it("rejects a stale workspace without changing the binding", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
    const before = ctx.router.getBinding(ctx.chatId).cwd;
    ctx.router.saveWorkspace("stale", "mypy");

    const result = await handleSlashCommand({ ...ctx, text: "/ws use stale" });

    expect((result as { text: string }).text).toContain("绝对路径");
    expect(ctx.router.getBinding(ctx.chatId).cwd).toBe(before);
  });
});

describe("/thinking", () => {
  const baseCtx = () => makeCtx({ scopedSessions: [], allSessions: [] });

  it("defaults to on, /thinking off then on flips the binding", async () => {
    const ctx = baseCtx();
    // 缺省：状态行须含 on 专属短语（不能只查 "on"——用法行本身含 on|off，会空断言）
    const status0 = await handleSlashCommand({ ...ctx, text: "/thinking" });
    expect((status0 as { text: string }).text).toContain("显示思考与工具调用过程");
    expect(ctx.router.getBinding(ctx.chatId).showThinking ?? true).toBe(true);

    const off = await handleSlashCommand({ ...ctx, text: "/thinking off" });
    expect((off as { text: string }).text).toContain("保留进度检查点和最终答案");
    expect(ctx.router.getBinding(ctx.chatId).showThinking).toBe(false);

    const status1 = await handleSlashCommand({ ...ctx, text: "/thinking" });
    expect((status1 as { text: string }).text).toContain("保留进度与最终答案");

    const on = await handleSlashCommand({ ...ctx, text: "/thinking on" });
    expect((on as { text: string }).text).toContain("显示思考");
    expect(ctx.router.getBinding(ctx.chatId).showThinking).toBe(true);
  });

  it("accepts 关/开 synonyms and rejects garbage without touching the binding", async () => {
    const ctx = baseCtx();
    await handleSlashCommand({ ...ctx, text: "/thinking 关" });
    expect(ctx.router.getBinding(ctx.chatId).showThinking).toBe(false);

    const bad = await handleSlashCommand({ ...ctx, text: "/thinking maybe" });
    expect((bad as { text: string }).text).toContain("无效参数");
    expect(ctx.router.getBinding(ctx.chatId).showThinking).toBe(false); // 未被改动

    await handleSlashCommand({ ...ctx, text: "/think 开" }); // /think 别名
    expect(ctx.router.getBinding(ctx.chatId).showThinking).toBe(true);
  });

  it("survives a backend switch (display preference, not a run override)", async () => {
    const ctx = baseCtx();
    await handleSlashCommand({ ...ctx, text: "/thinking off" });
    await handleSlashCommand({ ...ctx, text: "/backend claude" });
    expect(ctx.router.getBinding(ctx.chatId).showThinking).toBe(false);
  });

  it("/status reflects the thinking state", async () => {
    const ctx = baseCtx();
    await handleSlashCommand({ ...ctx, text: "/thinking off" });
    const status = await handleSlashCommand({ ...ctx, text: "/status" });
    expect((status as { text: string }).text).toContain("保留进度与最终答案");
  });

  it("/status reports the current slot session and active run from the catalog", async () => {
    const ctx = baseCtx();
    ctx.getSlotCommandContext = async () => ({
      sessionId: "sess_resumed",
      activeRunId: "run_42",
      providerSessionId: null,
    });

    const status = await handleSlashCommand({ ...ctx, text: "/status" });
    const text = (status as { text: string }).text;
    expect(text).toContain("**sessionId**: sess_resumed");
    expect(text).toContain("**activeRun**: run_42");
    expect(text).toContain("**runnerActive**: 是");
  });

  it("/status shows no bound session when the slot is unbound", async () => {
    const ctx = baseCtx();
    ctx.getSlotCommandContext = async () => ({
      sessionId: null,
      activeRunId: null,
      providerSessionId: null,
    });

    const status = await handleSlashCommand({ ...ctx, text: "/status" });
    const text = (status as { text: string }).text;
    expect(text).toContain("**sessionId**: (none)");
    expect(text).toContain("**runnerActive**: 否");
  });

  it("/resume success is visible in /status via the catalog binding", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-resume-status-"));
    tmpDirs.push(cwd);
    const ctx = baseCtx();
    ctx.listSessions = async () => [
      makeSession("provider_old", cwd, "old work"),
    ];

    await handleSlashCommand({ ...ctx, text: "/resume 1" });
    const status = await handleSlashCommand({ ...ctx, text: "/status" });

    expect((status as { text: string }).text).toContain(
      "**sessionId**: sess_provider_old",
    );
  });

  it("/new bumps the slot generation and keeps the old binding", async () => {
    const ctx = baseCtx();
    const before = ctx.router.getSlotGeneration(ctx.chatId);

    const result = await handleSlashCommand({ ...ctx, text: "/new" });

    expect((result as { text: string }).text).toContain("已新建会话");
    expect(ctx.router.getSlotGeneration(ctx.chatId)).toBe(before + 1);
  });

  it("/continue resumes only the current slot's session", async () => {
    const ctx = baseCtx();
    const resumedSessions: string[] = [];
    ctx.resumeQueue = async (sessionId) => {
      resumedSessions.push(sessionId);
      return { queueState: "ready" };
    };
    ctx.getSlotCommandContext = async () => ({
      sessionId: "sess_current",
      activeRunId: null,
      providerSessionId: null,
    });

    const result = await handleSlashCommand({ ...ctx, text: "/continue" });

    expect((result as { text: string }).text).toContain("已恢复队列");
    expect(resumedSessions).toEqual(["sess_current"]);
  });

  it("short aliases /c /r /s /x /b /a /d match the full commands", async () => {
    const ctx = baseCtx();
    const resumedSessions: string[] = [];
    ctx.resumeQueue = async (sessionId) => {
      resumedSessions.push(sessionId);
      return { queueState: "ready" };
    };
    ctx.getSlotCommandContext = async () => ({
      sessionId: "sess_current",
      activeRunId: "run_1",
      providerSessionId: null,
    });
    ctx.cancelActiveRun = async () => true;
    ctx.resolvePermission = async () => true;
    ctx.listSessions = async () => [
      makeSession("provider_old", "/tmp", "old work"),
    ];

    const continued = await handleSlashCommand({ ...ctx, text: "/c" });
    const status = await handleSlashCommand({ ...ctx, text: "/s" });
    const stopped = await handleSlashCommand({ ...ctx, text: "/x" });
    const backend = await handleSlashCommand({ ...ctx, text: "/b cursor" });
    const approved = await handleSlashCommand({ ...ctx, text: "/a" });
    const denied = await handleSlashCommand({ ...ctx, text: "/d" });
    const resumed = await handleSlashCommand({ ...ctx, text: "/r" });

    expect((continued as { text: string }).text).toContain("已恢复队列");
    expect(resumedSessions).toEqual(["sess_current"]);
    expect((status as { text: string }).text).toContain("**sessionId**: sess_current");
    expect((stopped as { text: string }).text).toContain("已停止");
    expect((backend as { text: string }).text).toContain("已切换 backend: cursor");
    expect((approved as { text: string }).text).toContain("已允许");
    expect((denied as { text: string }).text).toContain("已拒绝");
    expect((resumed as { text: string }).text).toContain("本地 session");
  });

  it("switches /backend among the five supported Agents and uses Web defaultAgent", async () => {
    const ctx = baseCtx();
    ctx.config = {
      ...ctx.config,
      defaultAgent: "pi",
      defaultBackend: "cursor",
    };

    const opencode = await handleSlashCommand({ ...ctx, text: "/backend opencode" });
    expect((opencode as { text: string }).text).toContain("已切换 backend: opencode");
    expect(ctx.router.getBinding(ctx.chatId).backendId).toBe("opencode");

    const reset = await handleSlashCommand({ ...ctx, text: "/backend default" });
    expect((reset as { text: string }).text).toContain("已切换 backend: pi");
    expect(ctx.router.getBinding(ctx.chatId).backendId).toBe("pi");
  });

  it("/continue with no bound session is a no-op", async () => {
    const ctx = baseCtx();
    const resumedSessions: string[] = [];
    ctx.resumeQueue = async (sessionId) => {
      resumedSessions.push(sessionId);
      return { queueState: "ready" };
    };

    const result = await handleSlashCommand({ ...ctx, text: "/continue" });

    expect((result as { text: string }).text).toContain("还没有 session");
    expect(resumedSessions).toEqual([]);
  });

  it("/steer refuses without an active run in the slot", async () => {
    const ctx = baseCtx();
    ctx.getSlotCommandContext = async () => ({
      sessionId: "sess_1",
      activeRunId: null,
      providerSessionId: null,
    });
    const steer = ctx.steerActiveRun = vi.fn();

    const result = await handleSlashCommand({
      ...ctx,
      text: "/steer 继续查",
    });

    expect((result as { text: string }).text).toContain("没有运行中的任务");
    expect(steer).not.toHaveBeenCalled();
  });
});

describe("channel slash catalog", () => {
  function sample(command: string): string {
    return command.replace(/\s*\[.*$/, "").replace(/\s*<.*$/, "").trim();
  }

  it("intercepts every documented 码桥 command instead of forwarding to the Agent", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-ws-"));
    tmpDirs.push(workspace);
    ctx.config = {
      ...ctx.config,
      workspaces: { root: workspace, default: workspace },
    };
    ctx.router.initFromConfig(ctx.config);
    ctx.cancelActiveRun = async () => false;
    ctx.resolvePermission = async () => false;
    ctx.listConfigOptions = async () => [];

    const samples = [
      ...SLASH_COMMANDS.map((item) => sample(item.command)),
      "/s",
      "/c",
      "/r",
      "/x",
      "/b",
      "/a",
      "/d",
      "/perm",
      "/think",
      "/menu",
      "/ws list",
      "/help full",
      "/resume last",
      "/backend pi",
      "/backend opencode",
    ];
    const leaked: string[] = [];
    const rows: Array<{ text: string; type: string }> = [];
    for (const text of [...new Set(samples)]) {
      const result = await handleSlashCommand({ ...ctx, text });
      const type = result?.type ?? "null";
      rows.push({ text, type });
      if (type === "agent" || type === "null") leaked.push(`${text} → ${type}`);
    }

    expect(leaked, JSON.stringify(rows, null, 2)).toEqual([]);

    const ws = await handleSlashCommand({ ...ctx, text: "/ws list" });
    expect(ws?.type).toBe("reply");
    expect((ws as { text: string }).text).toMatch(/工作区|暂无命名/);

    const unknown = await handleSlashCommand({
      ...ctx,
      text: "/skill:project-review",
    });
    expect(unknown).toEqual({
      type: "agent",
      prompt: "/skill:project-review",
    });
  });
});
