import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultConfig,
  type BackendConfigOption,
} from "@feishu-code-bridge/core";
import type { CliSessionSummary } from "@feishu-code-bridge/runner-client";
import { handleSlashCommand, type SlashContext } from "./slash-commands.js";
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
  bound?: string[];
  closeSession?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  deleteSession?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
}): SlashContext {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-slash-"));
  tmpDirs.push(dataDir);
  const router = new SessionRouter(dataDir);
  const config = defaultConfig();
  router.initFromConfig(config);
  const bound = overrides.bound ?? [];
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
    bindSession: (sessionId) => bound.push(sessionId),
    closeSession: overrides.closeSession,
    deleteSession: overrides.deleteSession,
  };
}

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
    const bound: string[] = [];
    const ctx = makeCtx({ scopedSessions: scoped, allSessions: all, bound });

    const listing = await handleSlashCommand({ ...ctx, text: "/resume all" });
    expect(listing?.type).toBe("reply");
    expect((listing as { text: string }).text).toContain("proj-2");

    const picked = await handleSlashCommand({ ...ctx, text: "/resume 1" });
    expect((picked as { text: string }).text).toContain("go-1");
    expect(bound).toEqual(["go-1"]);
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
    const bound: string[] = [];
    const ctx = makeCtx({ scopedSessions: scoped, allSessions: [], bound });

    const picked = await handleSlashCommand({ ...ctx, text: "/resume 2" });
    expect((picked as { text: string }).text).toContain("second");
    expect(bound).toEqual(["scoped-2"]);
  });

  it("plain /resume caches the scoped list for a later /resume <N>", async () => {
    const scoped = [
      makeSession("scoped-1", "/Users/keliang/Projects", "first"),
      makeSession("scoped-2", "/Users/keliang/Projects", "second"),
    ];
    const bound: string[] = [];
    const ctx = makeCtx({ scopedSessions: scoped, allSessions: [], bound });

    await handleSlashCommand({ ...ctx, text: "/resume" });
    const picked = await handleSlashCommand({ ...ctx, text: "/resume 1" });
    expect((picked as { text: string }).text).toContain("first");
    expect(bound).toEqual(["scoped-1"]);
  });

  it("invalid index reports against the cached list's length", async () => {
    const all = [makeSession("go-1", "/Users/keliang/go", "only one")];
    const ctx = makeCtx({ scopedSessions: [], allSessions: all });

    await handleSlashCommand({ ...ctx, text: "/resume all" });
    const picked = await handleSlashCommand({ ...ctx, text: "/resume 5" });
    expect((picked as { text: string }).text).toContain("共 1 条");
  });

  it("does not bind a session whose working directory no longer exists", async () => {
    const missing = path.join(os.tmpdir(), "fcb-missing-resume-directory");
    const bound: string[] = [];
    const ctx = makeCtx({
      scopedSessions: [],
      allSessions: [makeSession("missing-1", missing, "gone")],
      bound,
    });
    const before = ctx.router.getBinding(ctx.chatId).cwd;

    await handleSlashCommand({ ...ctx, text: "/resume all" });
    const picked = await handleSlashCommand({ ...ctx, text: "/resume 1" });

    expect((picked as { text: string }).text).toContain("不存在");
    expect(bound).toEqual([]);
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
  it("forwards an in-flight steering prompt to Runner", async () => {
    const ctx = makeCtx({ scopedSessions: [], allSessions: [] });
    const prompts: string[] = [];
    ctx.steerActiveRun = async (prompt) => {
      prompts.push(prompt);
      return { ok: true, outcome: "injected" };
    };

    const result = await handleSlashCommand({
      ...ctx,
      text: "/steer focus on tests",
    });
    expect((result as { text: string }).text).toContain("injected");
    expect(prompts).toEqual(["focus on tests"]);
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
    expect((off as { text: string }).text).toContain("只显示最终答案");
    expect(ctx.router.getBinding(ctx.chatId).showThinking).toBe(false);

    const status1 = await handleSlashCommand({ ...ctx, text: "/thinking" });
    expect((status1 as { text: string }).text).toContain("卡片只显示最终答案");

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
    expect((status as { text: string }).text).toContain("只显示最终答案");
  });
});
