import { execSync } from "node:child_process";
import type { AppConfig, BackendConfigOption } from "@feishu-code-bridge/core";
import type { CliSessionSummary } from "@feishu-code-bridge/runner-client";
import {
  formatFullCommandHelp,
} from "./command-help.js";
import {
  CLAUDE_PERMISSION_MODES,
  EFFORT_LEVELS,
  backendSupportsEffort,
  backendSupportsPermissionMode,
  formatDynamicModelHelp,
  formatEffortHelp,
  formatModelHelp,
  formatPermissionHelp,
} from "./model-effort.js";
import {
  compactProjectPath,
  formatElapsed,
  formatSessionListFooter,
  formatSessionListHeader,
  formatSessionLine,
} from "./session-list-format.js";
import type { SessionRouter } from "./session-router.js";

export interface SlashContext {
  chatId: string;
  topicId?: string;
  senderId: string;
  text: string;
  config: AppConfig;
  router: SessionRouter;
  listCliSessions?: (
    options?: { all?: boolean; limit?: number },
  ) => Promise<CliSessionSummary[]>;
  bindCliSession?: (sessionId: string) => void;
  /** /model 动态列表：拉取 ACP 适配器 advertise 的会话配置项（含真实模型列表） */
  listConfigOptions?: () => Promise<BackendConfigOption[]>;
  cancelActiveRun?: () => Promise<boolean>;
  hasActiveRun?: () => boolean;
  activeRunElapsedMs?: () => number | undefined;
}

export type SlashResult =
  | { type: "reply"; text: string }
  | { type: "noop" }
  | { type: "agent"; prompt: string }
  | { type: "config_updated"; text: string }
  | { type: "send_file"; path: string };

export async function handleSlashCommand(
  ctx: SlashContext,
): Promise<SlashResult | null> {
  const trimmed = ctx.text.trim();
  if (!trimmed.startsWith("/")) return null;

  const [cmd, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(" ").trim();
  const lower = cmd!.toLowerCase();

  switch (lower) {
    case "/help":
    case "/menu":
      return {
        type: "reply",
        text: formatFullCommandHelp(),
      };

    case "/new":
    case "/reset":
      ctx.router.clearSession(ctx.chatId, ctx.topicId);
      return {
        type: "reply",
        text: "已新建会话，下一条消息将开启新的 Agent session。",
      };

    case "/stop":
    case "/cancel":
      if (!ctx.cancelActiveRun) {
        return {
          type: "reply",
          text: "Runner 未就绪，无法停止任务。",
        };
      }
      {
        const stopped = await ctx.cancelActiveRun();
        return {
          type: "reply",
          text: stopped
            ? "已停止当前正在执行的 Agent 任务。"
            : "当前没有正在运行的任务。",
        };
      }

    case "/resume":
      return handleResume(ctx, arg);

    case "/send":
      if (!arg) {
        return {
          type: "reply",
          text: "用法: `/send /绝对路径/文件` 或 `/send ~/Desktop/xx.csv`（发送 Bridge 所在机器上的文件）",
        };
      }
      return { type: "send_file", path: arg };

    case "/status": {
      const key = ctx.router.buildSessionKey(ctx.chatId, ctx.topicId);
      const rec = ctx.router.getSessionRecord(key);
      const runOpts = ctx.router.resolveRunOptions(
        ctx.chatId,
        ctx.topicId,
        ctx.config,
      );
      const binding = ctx.router.getBinding(ctx.chatId, ctx.topicId);
      const profile = ctx.config.backends[key.backendId];
      const elapsedMs = ctx.activeRunElapsedMs?.();
      const runnerActive =
        elapsedMs !== undefined
          ? `是（已运行 ${formatElapsed(elapsedMs)}，请稍候再追问；需要中断请发 \`/stop\`）`
          : "否";
      return {
        type: "reply",
        text: [
          `**backend**: ${key.backendId}`,
          `**cwd**: ${key.cwd}`,
          `**model**: ${runOpts.model ?? "(CLI 默认)"}${binding.model ? " _(会话覆盖)_" : profile?.model ? " _(配置默认)_" : ""}`,
          `**transport**: ${runOpts.transport}${binding.transport ? " _(会话覆盖)_" : profile?.transport ? " _(配置默认)_" : " _(默认 acp)_"}`,
          `**effort**: ${backendSupportsEffort(key.backendId) ? (runOpts.effort ?? "(CLI 默认)") : "_(不支持)_"}${binding.effort ? " _(会话覆盖)_" : profile?.effort ? " _(配置默认)_" : ""}`,
          `**permission**: ${backendSupportsPermissionMode(key.backendId) ? (runOpts.claudePermissionMode ?? "bypassPermissions") : "_(不支持)_"}${binding.claudePermissionMode ? " _(会话覆盖)_" : profile?.claudePermissionMode ? " _(配置默认)_" : ""}`,
          `**cliSessionId**: ${rec?.cliSessionId ?? "(none)"}`,
          `**sessionTransport**: ${rec?.transport ?? "-"}`,
          `**lastRunAt**: ${rec?.lastRunAt ?? "-"}`,
          `**runnerActive**: ${runnerActive}`,
        ].join("\n"),
      };
    }

    case "/model":
      return handleModel(ctx, arg);

    case "/effort":
      return handleEffort(ctx, arg);

    case "/transport":
      return handleTransport(ctx, arg);

    case "/permission":
    case "/perm":
      return handlePermission(ctx, arg);

    case "/cd": {
      if (!arg) return { type: "reply", text: "用法: `/cd /path/to/project`" };
      ctx.router.setBinding(ctx.chatId, { cwd: arg }, ctx.topicId);
      ctx.router.clearSession(ctx.chatId, ctx.topicId);
      return { type: "reply", text: `已切换工作目录: ${arg}` };
    }

    case "/backend": {
      const id = arg === "default" || !arg ? ctx.config.defaultBackend : arg;
      if (!ctx.config.backends[id]) {
        return {
          type: "reply",
          text: `未知 backend: ${id}。可选: ${Object.keys(ctx.config.backends).join(", ")}`,
        };
      }
      ctx.router.setBinding(ctx.chatId, { backendId: id }, ctx.topicId);
      ctx.router.clearRunOverrides(ctx.chatId, ctx.topicId);
      ctx.router.clearSession(ctx.chatId, ctx.topicId);
      const profile = ctx.config.backends[id];
      const modelHint = profile?.model ? `，model 默认 \`${profile.model}\`` : "";
      return {
        type: "reply",
        text: `已切换 backend: ${id}${modelHint}（已清除上一 backend 的 model/effort/transport 覆盖及续聊 session）`,
      };
    }

    case "/pull": {
      const cwd = ctx.router.getBinding(ctx.chatId, ctx.topicId).cwd;
      try {
        const out = execSync("git pull --ff-only", {
          cwd,
          encoding: "utf8",
        });
        return { type: "reply", text: `git pull:\n${out}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { type: "reply", text: `git pull 失败: ${msg}` };
      }
    }

    default:
      if (lower === "/ws" || lower.startsWith("/ws")) {
        return handleWs(ctx, rest);
      }
      if (lower === "/clone") {
        return handleClone(ctx, rest);
      }
      if (lower === "/config") {
        const p = ctx.config.feishu.policy;
        return {
          type: "reply",
          text: [
            "**配置摘要**",
            `requireMention: ${p?.requireMention ?? true}`,
            `defaultBackend: ${ctx.config.defaultBackend}`,
            `runner: ${ctx.config.runner.url}`,
            "完整配置见 ~/.feishu-code-bridge/config.yaml",
          ].join("\n"),
        };
      }
      return { type: "agent", prompt: trimmed };
  }
}

/** 上一次 /resume 展示给用户的列表（按聊天/话题缓存），供 /resume <N> 按原序号定位 */
const RESUME_LIST_CACHE_MAX = 500;
const resumeListCache = new Map<string, CliSessionSummary[]>();

function resumeCacheKey(ctx: SlashContext): string {
  return `${ctx.chatId}|${ctx.topicId ?? ""}`;
}

function setResumeListCache(
  ctx: SlashContext,
  sessions: CliSessionSummary[],
): void {
  const cacheKey = resumeCacheKey(ctx);
  if (
    !resumeListCache.has(cacheKey) &&
    resumeListCache.size >= RESUME_LIST_CACHE_MAX
  ) {
    const oldest = resumeListCache.keys().next().value;
    if (oldest !== undefined) resumeListCache.delete(oldest);
  }
  resumeListCache.set(cacheKey, sessions);
}

async function handleResume(
  ctx: SlashContext,
  arg: string,
): Promise<SlashResult> {
  if (!ctx.listCliSessions || !ctx.bindCliSession) {
    return {
      type: "reply",
      text: "Runner 未就绪，无法列出 CLI session。请先启动 feishu-code-runner。",
    };
  }

  const key = ctx.router.buildSessionKey(ctx.chatId, ctx.topicId);
  const listAll = arg.toLowerCase() === "all";

  if (/^\d+$/.test(arg)) {
    const index = Number(arg);
    const sessions =
      resumeListCache.get(resumeCacheKey(ctx)) ??
      (await ctx.listCliSessions({ all: listAll }));
    const picked = sessions[index - 1];
    if (!picked) {
      return {
        type: "reply",
        text: `无效序号 ${index}。先发送 \`/resume\` 查看列表（共 ${sessions.length} 条）。`,
      };
    }
    ctx.bindCliSession(picked.id);
    return {
      type: "reply",
      text: [
        `已绑定 **${key.backendId}** session 到当前飞书会话：`,
        `- id: \`${picked.id}\``,
        `- cwd: ${picked.cwd}`,
        `- preview: ${picked.preview}`,
        "",
        "下一条消息将带 `--resume` 继续该 CLI session。",
      ].join("\n"),
    };
  }

  if (arg.toLowerCase() === "last") {
    const sessions = await ctx.listCliSessions();
    const picked = sessions[0];
    if (!picked) {
      return {
        type: "reply",
        text: `当前目录 \`${key.cwd}\` 下没有找到 **${key.backendId}** 本地 session。`,
      };
    }
    ctx.bindCliSession(picked.id);
    return {
      type: "reply",
      text: [
        `已绑定最近一条 **${key.backendId}** session：`,
        `- id: \`${picked.id}\``,
        `- preview: ${picked.preview}`,
        "",
        "下一条消息将带 `--resume` 继续。",
      ].join("\n"),
    };
  }

  if (arg && arg.toLowerCase() !== "all") {
    return {
      type: "reply",
      text: "用法: `/resume` | `/resume <N>` | `/resume last` | `/resume all`",
    };
  }

  const sessions = await ctx.listCliSessions({ all: listAll });
  const rec = ctx.router.getSessionRecord(key);
  if (sessions.length === 0) {
    const bound = rec?.cliSessionId
      ? `\n当前已绑定: \`${rec.cliSessionId}\``
      : "";
    const scopeHint = listAll
      ? "本机"
      : `\`${key.cwd}\` 及其子目录`;
    return {
      type: "reply",
      text: `在 ${scopeHint} 下未找到 **${key.backendId}** 本地 session。${bound}\n\n可在终端直接用对应 CLI 开聊后，再回来 \`/resume\`；或 \`/resume all\` 查看全部。`,
    };
  }

  const showCwd =
    listAll || new Set(sessions.map((s) => s.cwd)).size > 1;
  const displayLimit = 15;
  const visible = sessions.slice(0, displayLimit);
  const lines = listAll
    ? formatGroupedSessionLines(visible)
    : visible.map((s, i) => formatSessionLine(s, i, showCwd));
  const boundLine = rec?.cliSessionId ? rec.cliSessionId : undefined;
  setResumeListCache(ctx, visible);

  return {
    type: "reply",
    text: [
      formatSessionListHeader({
        backendId: key.backendId,
        scopeCwd: key.cwd,
        listAll,
        total: sessions.length,
        showCwd,
        displayLimit: sessions.length > displayLimit ? displayLimit : undefined,
      }),
      "",
      ...lines,
      "",
      formatSessionListFooter(boundLine),
    ].join("\n"),
  };
}

function formatGroupedSessionLines(sessions: CliSessionSummary[]): string[] {
  const lines: string[] = [];
  let currentCwd = "";
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]!;
    if (session.cwd !== currentCwd) {
      currentCwd = session.cwd;
      if (lines.length) lines.push("");
      lines.push(`**目录：${compactProjectPath(currentCwd)}**`);
    }
    lines.push(formatSessionLine(session, i, false));
  }
  return lines;
}

async function handleModel(
  ctx: SlashContext,
  arg: string,
): Promise<SlashResult> {
  const binding = ctx.router.getBinding(ctx.chatId, ctx.topicId);
  const backendId = binding.backendId;
  const profile = ctx.config.backends[backendId];

  if (!arg || arg.toLowerCase() === "list") {
    const runOpts = ctx.router.resolveRunOptions(
      ctx.chatId,
      ctx.topicId,
      ctx.config,
    );
    // 优先动态拉取适配器 advertise 的真实模型列表（ACP）；失败/为空回退静态提示
    if (ctx.listConfigOptions) {
      try {
        const options = await ctx.listConfigOptions();
        const model = options.find((o) => o.category === "model");
        if (model && model.values.length > 0) {
          return {
            type: "reply",
            text: formatDynamicModelHelp(backendId, model, runOpts.model),
          };
        }
      } catch {
        // 适配器未就绪等，回退静态提示
      }
    }
    return {
      type: "reply",
      text: formatModelHelp(backendId, runOpts.model),
    };
  }

  if (arg.toLowerCase() === "default") {
    ctx.router.clearModel(ctx.chatId, ctx.topicId);
    const fallback = profile?.model ?? "(CLI 默认)";
    return {
      type: "reply",
      text: `已清除会话 model 覆盖，将使用: ${fallback}`,
    };
  }

  ctx.router.setBinding(ctx.chatId, { model: arg }, ctx.topicId);
  return {
    type: "reply",
    text: `已设置 **${backendId}** model: \`${arg}\`\n下一条消息生效。`,
  };
}

function handleEffort(ctx: SlashContext, arg: string): SlashResult {
  const binding = ctx.router.getBinding(ctx.chatId, ctx.topicId);
  const backendId = binding.backendId;
  const profile = ctx.config.backends[backendId];

  if (!backendSupportsEffort(backendId)) {
    return {
      type: "reply",
      text: formatEffortHelp(backendId),
    };
  }

  if (!arg || arg.toLowerCase() === "list") {
    const runOpts = ctx.router.resolveRunOptions(
      ctx.chatId,
      ctx.topicId,
      ctx.config,
    );
    return {
      type: "reply",
      text: formatEffortHelp(backendId, runOpts.effort),
    };
  }

  if (arg.toLowerCase() === "default") {
    ctx.router.clearEffort(ctx.chatId, ctx.topicId);
    const fallback = profile?.effort ?? "(CLI 默认)";
    return {
      type: "reply",
      text: `已清除会话 effort 覆盖，将使用: ${fallback}`,
    };
  }

  const level = arg.toLowerCase();
  if (!EFFORT_LEVELS.includes(level as (typeof EFFORT_LEVELS)[number])) {
    return {
      type: "reply",
      text: `无效 effort: ${arg}\n可选: ${EFFORT_LEVELS.join(", ")}`,
    };
  }

  ctx.router.setBinding(ctx.chatId, { effort: level }, ctx.topicId);
  return {
    type: "reply",
    text: `已设置 Claude effort: \`${level}\`\n下一条消息生效。`,
  };
}

const TRANSPORT_MODES = ["acp", "cli"] as const;

function formatTransportHelp(current: string, source?: string): string {
  const lines = [
    `当前 transport: \`${current}\`${source ? ` ${source}` : ""}`,
    "",
    "**acp** — Agent Client Protocol（默认，推荐）",
    "**cli** — 直接 spawn CLI（stream-json 回退）",
    "",
    "用法: `/transport acp|cli|default`",
  ];
  return lines.join("\n");
}

function handleTransport(ctx: SlashContext, arg: string): SlashResult {
  const binding = ctx.router.getBinding(ctx.chatId, ctx.topicId);
  const profile = ctx.config.backends[binding.backendId];
  const runOpts = ctx.router.resolveRunOptions(
    ctx.chatId,
    ctx.topicId,
    ctx.config,
  );
  const source = binding.transport
    ? "_(会话覆盖)_"
    : profile?.transport
      ? "_(配置默认)_"
      : "_(默认 acp)_";

  if (!arg || arg.toLowerCase() === "list") {
    return {
      type: "reply",
      text: formatTransportHelp(runOpts.transport, source),
    };
  }

  if (arg.toLowerCase() === "default") {
    const prevTransport = runOpts.transport;
    ctx.router.clearTransport(ctx.chatId, ctx.topicId);
    const fallback = profile?.transport ?? "acp";
    if (fallback !== prevTransport) {
      ctx.router.clearSession(ctx.chatId, ctx.topicId);
    }
    return {
      type: "reply",
      text:
        fallback !== prevTransport
          ? `已清除会话 transport 覆盖，将使用: ${fallback}\n已清除旧 session（CLI ↔ ACP 的续聊 ID 不通用）。`
          : `已清除会话 transport 覆盖，将使用: ${fallback}`,
    };
  }

  const mode = arg.toLowerCase();
  if (!TRANSPORT_MODES.includes(mode as (typeof TRANSPORT_MODES)[number])) {
    return {
      type: "reply",
      text: `无效 transport: ${arg}\n可选: ${TRANSPORT_MODES.join(", ")}`,
    };
  }

  ctx.router.setBinding(
    ctx.chatId,
    { transport: mode as (typeof TRANSPORT_MODES)[number] },
    ctx.topicId,
  );
  if (mode !== runOpts.transport) {
    ctx.router.clearSession(ctx.chatId, ctx.topicId);
  }
  return {
    type: "reply",
    text:
      mode !== runOpts.transport
        ? `已设置 transport: \`${mode}\`\n已清除旧 session（CLI ↔ ACP 的续聊 ID 不通用）。\n下一条消息生效。`
        : `已设置 transport: \`${mode}\`\n下一条消息生效。`,
  };
}

function handlePermission(ctx: SlashContext, arg: string): SlashResult {
  const binding = ctx.router.getBinding(ctx.chatId, ctx.topicId);
  const backendId = binding.backendId;
  const profile = ctx.config.backends[backendId];

  if (!backendSupportsPermissionMode(backendId)) {
    return {
      type: "reply",
      text: formatPermissionHelp(backendId),
    };
  }

  if (!arg || arg.toLowerCase() === "list") {
    const runOpts = ctx.router.resolveRunOptions(
      ctx.chatId,
      ctx.topicId,
      ctx.config,
    );
    return {
      type: "reply",
      text: formatPermissionHelp(
        backendId,
        runOpts.claudePermissionMode ?? "bypassPermissions",
      ),
    };
  }

  if (arg.toLowerCase() === "default") {
    ctx.router.clearClaudePermissionMode(ctx.chatId, ctx.topicId);
    const fallback =
      profile?.claudePermissionMode ?? "bypassPermissions（码桥默认）";
    return {
      type: "reply",
      text: `已清除会话 permission 覆盖，将使用: ${fallback}`,
    };
  }

  const mode = arg.trim();
  if (!(CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode)) {
    return {
      type: "reply",
      text: `无效 permission-mode: ${arg}\n可选: ${CLAUDE_PERMISSION_MODES.join(", ")}`,
    };
  }

  ctx.router.setBinding(
    ctx.chatId,
    { claudePermissionMode: mode as (typeof CLAUDE_PERMISSION_MODES)[number] },
    ctx.topicId,
  );
  return {
    type: "reply",
    text: `已设置 Claude permission-mode: \`${mode}\`\n下一条消息生效。`,
  };
}

function handleWs(ctx: SlashContext, rest: string[]): SlashResult {
  const sub = rest[0]?.toLowerCase();
  const name = rest[1];
  if (sub === "list") {
    const map = ctx.router.listWorkspaceNames();
    const lines = Object.entries(map).map(([k, v]) => `- **${k}**: ${v}`);
    return {
      type: "reply",
      text: lines.length ? lines.join("\n") : "（暂无命名工作区）",
    };
  }
  if (sub === "save" && name) {
    const cwd = ctx.router.getBinding(ctx.chatId, ctx.topicId).cwd;
    ctx.router.saveWorkspace(name, cwd);
    return { type: "reply", text: `已保存工作区 \`${name}\` → ${cwd}` };
  }
  if (sub === "use" && name) {
    const map = ctx.router.listWorkspaceNames();
    const cwd = map[name];
    if (!cwd) return { type: "reply", text: `未找到工作区: ${name}` };
    ctx.router.setBinding(ctx.chatId, { cwd }, ctx.topicId);
    ctx.router.clearSession(ctx.chatId, ctx.topicId);
    return { type: "reply", text: `已切换工作区: ${name} (${cwd})` };
  }
  if (sub === "remove" && name) {
    ctx.router.removeWorkspace(name);
    return { type: "reply", text: `已删除工作区: ${name}` };
  }
  return { type: "reply", text: "用法: `/ws list|save <名>|use <名>|remove <名>`" };
}

function handleClone(ctx: SlashContext, rest: string[]): SlashResult {
  const url = rest[0];
  const name = rest[1];
  if (!url) return { type: "reply", text: "用法: `/clone <git-url> [name]`" };
  const root =
    ctx.config.workspaces?.root ?? `${process.env.HOME}/Projects`;
  const dirName = name ?? url.split("/").pop()?.replace(/\.git$/, "") ?? "repo";
  const target = `${root}/${dirName}`;
  try {
    execSync(`git clone ${JSON.stringify(url)} ${JSON.stringify(target)}`, {
      encoding: "utf8",
    });
    ctx.router.setBinding(ctx.chatId, { cwd: target }, ctx.topicId);
    ctx.router.clearSession(ctx.chatId, ctx.topicId);
    return { type: "reply", text: `已 clone 到 ${target}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "reply", text: `clone 失败: ${msg}` };
  }
}

export function checkAccess(
  config: AppConfig,
  chatId: string,
  senderId: string,
  isDm: boolean,
): boolean {
  const access = config.access;
  if (!access) return true;
  if (access.allowedUsers?.length && !access.allowedUsers.includes(senderId)) {
    return false;
  }
  if (
    !isDm &&
    access.allowedChats?.length &&
    !access.allowedChats.includes(chatId)
  ) {
    return false;
  }
  return true;
}

export function isAdmin(config: AppConfig, senderId: string): boolean {
  const admins = config.access?.admins;
  if (!admins?.length) return true;
  return admins.includes(senderId);
}
