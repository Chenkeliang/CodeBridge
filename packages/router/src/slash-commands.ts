import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  ActiveRunStatus,
  AppConfig,
  BackendConfigOption,
} from "@codebridge/core";
import type { CliSessionSummary } from "@codebridge/runner-client";
import {
  type CommandHelpFormat,
  formatCompactCommandHelp,
  formatFullCommandHelp,
} from "./command-help.js";
import {
  formatDynamicModelHelp,
  formatDynamicOptionHelp,
  matchBackendConfigValue,
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
  listSessions?: (
    options?: { all?: boolean; limit?: number },
  ) => Promise<CliSessionSummary[]>;
  bindSession?: (sessionId: string) => void;
  resetSession?: () => Promise<void>;
  /** /resume：将 Provider Session 绑定到当前槽位（D6）。busy/conflict 供文案区分。 */
  resumeProviderSession?: (
    providerSessionId: string,
  ) => Promise<{
    ok: boolean;
    sessionId?: string;
    busy?: boolean;
    conflict?: boolean;
    error?: string;
  }>;
  closeSession?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  deleteSession?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  /** /model 动态列表：拉取 ACP 适配器 advertise 的会话配置项（含真实模型列表） */
  listConfigOptions?: () => Promise<BackendConfigOption[]>;
  cancelActiveRun?: () => Promise<boolean>;
  hasActiveRun?: () => boolean;
  activeRunElapsedMs?: () => number | undefined;
  activeRunStatus?: () => ActiveRunStatus | undefined;
  steerActiveRun?: (
    prompt: string,
  ) => Promise<{ ok: boolean; outcome?: string; error?: string }>;
  /** prompt_feishu：回应当前 run 挂起的权限请求（true=允许 false=拒绝） */
  resolvePermission?: (approve: boolean) => Promise<boolean>;
  /** 让 Runner 进程实际访问目录，触发 macOS TCC 对固定 helper 身份的授权提示 */
  authorizeDirectory?: (
    directory: string,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>;
  /** /root add 开始等待 macOS TCC 时，先向聊天发送即时状态提示 */
  notifyStatus?: (text: string) => Promise<void>;
  /** 帮助文本格式；飞书默认 Markdown，Telegram 使用纯文本。 */
  helpFormat?: CommandHelpFormat;
}

export type SlashResult =
  | { type: "reply"; text: string }
  | { type: "noop" }
  | { type: "agent"; prompt: string }
  | { type: "config_updated"; text: string }
  | { type: "send_file"; path: string };

function canonicalDirectory(raw: string):
  | { cwd: string }
  | { error: string } {
  if (!path.isAbsolute(raw)) {
    return { error: `工作目录必须使用绝对路径: ${raw}` };
  }
  try {
    const cwd = fs.realpathSync(raw);
    if (!fs.statSync(cwd).isDirectory()) {
      return { error: `工作目录不是目录: ${raw}` };
    }
    return { cwd };
  } catch {
    return { error: `工作目录不存在或无法访问: ${raw}` };
  }
}

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
      return {
        type: "reply",
        text:
          arg.toLowerCase() === "full"
            ? formatFullCommandHelp(ctx.helpFormat)
            : formatCompactCommandHelp(ctx.helpFormat),
      };

    case "/menu":
      return {
        type: "reply",
        text: formatCompactCommandHelp(ctx.helpFormat),
      };

    case "/new":
    case "/reset":
      await ctx.resetSession?.();
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

    case "/steer": {
      if (!arg) {
        return {
          type: "reply",
          text: "用法：`/steer <补充指令>`（注入当前正在执行的 ACP turn）",
        };
      }
      if (!ctx.steerActiveRun) {
        return { type: "reply", text: "Runner 未就绪，无法发送 steering。" };
      }
      const result = await ctx.steerActiveRun(arg);
      return {
        type: "reply",
        text: result.ok
          ? `已发送 steering：${result.outcome ?? "accepted"}`
          : `Steering 失败：${result.error ?? "当前 Agent 不支持或没有运行中的任务"}`,
      };
    }

    case "/approve":
    case "/deny": {
      if (!ctx.resolvePermission) {
        return { type: "reply", text: "Runner 未就绪，无法回应权限请求。" };
      }
      const approve = lower === "/approve";
      const resolved = await ctx.resolvePermission(approve);
      return {
        type: "reply",
        text: resolved
          ? approve
            ? "✅ 已允许，任务继续。"
            : "⛔ 已拒绝该操作，任务继续（agent 会收到拒绝结果）。"
          : "当前没有等待回应的权限请求。",
      };
    }

    case "/resume":
      try {
        return await handleResume(ctx, arg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          type: "reply",
          text: `ACP session 列表读取失败：${message}\n\n请运行 \`./scripts/start.sh doctor\` 检查 adapter。`,
        };
      }

    case "/session": {
      const [action, sessionId, ...extra] = arg.split(/\s+/).filter(Boolean);
      if (
        (action !== "close" && action !== "delete") ||
        !sessionId ||
        extra.length > 0
      ) {
        const operation = action === "delete" ? "delete" : "close";
        return {
          type: "reply",
          text: `用法：\`/session ${operation} <sessionId>\``,
        };
      }
      const callback =
        action === "close" ? ctx.closeSession : ctx.deleteSession;
      if (!callback) {
        return { type: "reply", text: "Runner 未就绪，无法管理 ACP session。" };
      }
      const result = await callback(sessionId);
      if (!result.ok) {
        return {
          type: "reply",
          text: `${action === "close" ? "关闭" : "删除"} ACP session 失败：${result.error ?? "未知错误"}`,
        };
      }
      return {
        type: "reply",
        text: `已${action === "close" ? "关闭" : "删除"} ACP session：\`${sessionId}\``,
      };
    }

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
      const activeStatus = ctx.activeRunStatus?.();
      const elapsedMs = activeStatus
        ? Date.now() - activeStatus.startedAt
        : ctx.activeRunElapsedMs?.();
      const runnerActive =
        elapsedMs !== undefined
          ? `是（已运行 ${formatElapsed(elapsedMs)}，请稍候再追问；需要中断请发 \`/stop\`）`
          : "否";
      return {
        type: "reply",
        text: [
          `**backend**: ${key.backendId}`,
          `**cwd**: ${key.cwd}`,
          `**model**: ${runOpts.model ?? "(ACP 默认)"}${binding.model ? " _(会话覆盖)_" : profile?.model ? " _(配置默认)_" : ""}`,
          "**transport**: acp",
          `**effort**: ${runOpts.effort ?? "(ACP 默认)"}${binding.effort ? " _(会话覆盖)_" : profile?.effort ? " _(配置默认)_" : ""}`,
          `**mode/permission**: ${runOpts.mode ?? "(ACP 默认)"}${binding.mode ? " _(会话覆盖)_" : profile?.claudePermissionMode ? " _(配置默认)_" : ""}`,
          `**additionalDirectories**: ${binding.additionalDirectories?.length ? binding.additionalDirectories.join(", ") : "(none)"}`,
          `**thinking**: ${(binding.showThinking ?? true) ? "on（显示思考/工具过程）" : "off（隐藏内部思考/工具，保留进度与最终答案）"}`,
          `**sessionId**: ${rec?.sessionId ?? "(none)"}`,
          `**lastRunAt**: ${rec?.lastRunAt ?? "-"}`,
          `**runnerActive**: ${runnerActive}`,
          activeStatus
            ? `**currentPhase**: ${activeStatus.currentPhase}`
            : undefined,
          activeStatus
            ? `**lastRealActivity**: ${formatElapsed(Date.now() - activeStatus.lastActivityAt)}之前`
            : undefined,
          activeStatus?.lastCheckpoint
            ? `**lastCheckpoint**: ${activeStatus.lastCheckpoint}`
            : undefined,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      };
    }

    case "/model":
      return handleModel(ctx, arg);

    case "/effort":
      return handleEffort(ctx, arg);

    case "/transport":
      return { type: "reply", text: "当前仅支持 ACP，无需切换 transport。" };

    case "/permission":
    case "/perm":
      return handlePermission(ctx, arg);

    case "/thinking":
    case "/think":
      return handleThinking(ctx, arg);

    case "/cd": {
      if (!arg) return { type: "reply", text: "用法: `/cd /path/to/project`" };
      const resolved = canonicalDirectory(arg);
      if ("error" in resolved) {
        return { type: "reply", text: resolved.error };
      }
      ctx.router.setBinding(ctx.chatId, { cwd: resolved.cwd }, ctx.topicId);
      ctx.router.clearSession(ctx.chatId, ctx.topicId);
      return { type: "reply", text: `已切换工作目录: ${resolved.cwd}` };
    }

    case "/root":
    case "/roots":
      return handleAdditionalDirectories(ctx, arg);

    case "/config":
      return handleAcpConfig(ctx, arg);

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
        text: `已切换 backend: ${id}${modelHint}（已清除上一 backend 的 model/effort 覆盖及续聊 session）`,
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
      return { type: "agent", prompt: trimmed };
  }
}

async function handleAdditionalDirectories(
  ctx: SlashContext,
  arg: string,
): Promise<SlashResult> {
  const binding = ctx.router.getBinding(ctx.chatId, ctx.topicId);
  const directories = binding.additionalDirectories ?? [];
  const [operation, ...pathParts] = arg.split(/\s+/).filter(Boolean);
  const op = operation?.toLowerCase();

  if (!arg || op === "list") {
    return {
      type: "reply",
      text: directories.length
        ? ["**ACP 附加目录**", ...directories.map((dir, i) => `${i + 1}. ${dir}`)].join(
            "\n",
          )
        : "当前没有 ACP 附加目录。用法：`/root add /absolute/path`",
    };
  }

  if (op !== "add" && op !== "remove" && op !== "rm") {
    return {
      type: "reply",
      text: "用法：`/roots`、`/root add /absolute/path`、`/root remove /absolute/path`",
    };
  }

  const rawPath = pathParts.join(" ").trim();
  if (!rawPath) {
    return {
      type: "reply",
      text: `用法：\`/root ${op} /absolute/path\``,
    };
  }

  let target: string;
  if (op === "add") {
    let authorization = "";
    if (ctx.authorizeDirectory) {
      if (!path.isAbsolute(rawPath)) {
        return { type: "reply", text: `工作目录必须使用绝对路径: ${rawPath}` };
      }
      await ctx.notifyStatus?.(
        "⏳ Runner 正在请求 macOS 目录权限，请查看系统弹窗。",
      ).catch(() => {});
      try {
        const result = await ctx.authorizeDirectory(rawPath);
        if (!result.ok && !result.path) {
          return {
            type: "reply",
            text: `Runner 无法验证目录访问权限：${result.error ?? "目录不存在或无法访问"}`,
          };
        }
        target = result.path ?? path.resolve(rawPath);
        authorization = result.ok
          ? "\nRunner 已验证目录访问权限。"
          : `\nRunner 尚未获得目录访问权限：${result.error ?? "请在 macOS 弹窗中允许后重试"}`;
      } catch (err) {
        // Runner 暂时不可用时保留旧的本地校验作为回退；正常 TCC 路径不会触碰 Bridge 的文件权限。
        const resolved = canonicalDirectory(rawPath);
        if ("error" in resolved) return { type: "reply", text: resolved.error };
        target = resolved.cwd;
        authorization = `\nRunner 目录授权检查失败：${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      const resolved = canonicalDirectory(rawPath);
      if ("error" in resolved) return { type: "reply", text: resolved.error };
      target = resolved.cwd;
    }
    if (target === binding.cwd) {
      return { type: "reply", text: "附加目录不能与当前工作目录相同。" };
    }
    if (directories.includes(target)) {
      return { type: "reply", text: `附加目录已存在：${target}` };
    }
    ctx.router.setBinding(
      ctx.chatId,
      { additionalDirectories: [...directories, target] },
      ctx.topicId,
    );
    return {
      type: "reply",
      text: `已添加 ACP 附加目录：${target}${authorization}\n下一条消息生效；macOS TCC 仍需用户确认。`,
    };
  }

  if (!path.isAbsolute(rawPath)) {
    return { type: "reply", text: `附加目录必须使用绝对路径: ${rawPath}` };
  }
  try {
    target = fs.realpathSync(rawPath);
  } catch {
    target = path.resolve(rawPath);
  }
  if (!directories.includes(target)) {
    return { type: "reply", text: `附加目录不存在于当前会话：${target}` };
  }
  ctx.router.setBinding(
    ctx.chatId,
    { additionalDirectories: directories.filter((dir) => dir !== target) },
    ctx.topicId,
  );
  return { type: "reply", text: `已移除 ACP 附加目录：${target}` };
}

async function handleAcpConfig(
  ctx: SlashContext,
  arg: string,
): Promise<SlashResult> {
  if (!ctx.listConfigOptions) {
    return { type: "reply", text: "Runner 未就绪，无法读取 ACP 配置能力。" };
  }
  let options: BackendConfigOption[];
  try {
    options = await ctx.listConfigOptions();
  } catch (err) {
    return {
      type: "reply",
      text: `ACP 配置能力读取失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const binding = ctx.router.getBinding(ctx.chatId, ctx.topicId);
  const overrides = binding.acpConfig ?? {};
  const [configId, ...valueParts] = arg.split(/\s+/).filter(Boolean);
  if (!configId) {
    if (!options.length) return { type: "reply", text: "当前 ACP 适配器没有可配置项。" };
    return {
      type: "reply",
      text: [
        "**ACP 实时配置**",
        ...options.map((option) => {
          const value = overrides[option.id] ?? option.currentValue ?? "(默认)";
          return `- \`${option.id}\` · ${option.name} · ${option.type ?? "select"} · 当前: \`${String(value)}\``;
        }),
        "",
        "用法：`/config <id> <value>`；恢复默认：`/config <id> default`",
      ].join("\n"),
    };
  }
  const option = options.find((candidate) => candidate.id === configId);
  if (!option) return { type: "reply", text: `未知 ACP config id：\`${configId}\`` };
  const rawValue = valueParts.join(" ").trim();
  if (!rawValue) {
    return {
      type: "reply",
      text: `用法：\`/config ${configId} <value>\`\n当前：\`${String(overrides[configId] ?? option.currentValue ?? "(默认)")}\``,
    };
  }
  if (rawValue.toLowerCase() === "default") {
    const next = { ...overrides };
    delete next[configId];
    ctx.router.setBinding(ctx.chatId, { acpConfig: next }, ctx.topicId);
    return { type: "reply", text: `已清除 ACP config 覆盖：\`${configId}\`` };
  }
  let value: string | boolean;
  if (option.type === "boolean") {
    const lowerValue = rawValue.toLowerCase();
    if (["true", "on", "1", "yes"].includes(lowerValue)) value = true;
    else if (["false", "off", "0", "no"].includes(lowerValue)) value = false;
    else return { type: "reply", text: `\`${configId}\` 需要 true/false（或 on/off）。` };
  } else {
    const matched = matchBackendConfigValue(option, rawValue);
    if (!matched) return invalidLiveValue(`config ${configId}`, rawValue, option);
    value = matched;
  }
  ctx.router.setBinding(
    ctx.chatId,
    { acpConfig: { ...overrides, [configId]: value } },
    ctx.topicId,
  );
  return {
    type: "reply",
    text: `已设置 ACP config：\`${configId}\` = \`${String(value)}\`\n下一条消息生效。`,
  };
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

/** D6：把 Provider Session 绑定到当前槽位；槽位已绑他 Session 时 +1 代重试。 */
async function resumeBoundSession(
  ctx: SlashContext,
  providerSessionId: string,
): Promise<{ ok: true; sessionId: string } | { ok: false; text: string }> {
  if (!ctx.resumeProviderSession) {
    return { ok: false, text: "Runner 未就绪，无法 /resume。" };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await ctx.resumeProviderSession(providerSessionId);
    if (result.ok && result.sessionId) {
      return { ok: true, sessionId: result.sessionId };
    }
    if (result.busy) {
      return {
        ok: false,
        text: `Provider session \`${providerSessionId}\` 正被其他任务占用，请稍后再试。`,
      };
    }
    if (result.conflict) {
      // 当前槽位已绑别的 Session：+1 代后重试（保留旧绑定不被打断）。
      ctx.router.incrementSlotGeneration(ctx.chatId, ctx.topicId);
      continue;
    }
    return { ok: false, text: `绑定失败：${result.error ?? "未知错误"}` };
  }
  return { ok: false, text: "绑定失败：槽位冲突。请先 /new 再试。" };
}

async function handleResume(
  ctx: SlashContext,
  arg: string,
): Promise<SlashResult> {
  if (!ctx.listSessions || !ctx.resumeProviderSession) {
    return {
      type: "reply",
      text: "Runner 未就绪，无法列出/绑定 ACP session。请先启动 codebridge-runner。",
    };
  }

  const key = ctx.router.buildSessionKey(ctx.chatId, ctx.topicId);
  const listAll = arg.toLowerCase() === "all";

  if (/^\d+$/.test(arg)) {
    const index = Number(arg);
    const sessions =
      resumeListCache.get(resumeCacheKey(ctx)) ??
      (await ctx.listSessions({ all: listAll }));
    const picked = sessions[index - 1];
    if (!picked) {
      return {
        type: "reply",
        text: `无效序号 ${index}。先发送 \`/resume\` 查看列表（共 ${sessions.length} 条）。`,
      };
    }
    const resolved = canonicalDirectory(picked.cwd);
    if ("error" in resolved) {
      return { type: "reply", text: resolved.error };
    }
    ctx.router.setBinding(
      ctx.chatId,
      {
        cwd: resolved.cwd,
        additionalDirectories: picked.additionalDirectories ?? [],
      },
      ctx.topicId,
    );
    const resumed = await resumeBoundSession(ctx, picked.id);
    if (!resumed.ok) {
      return { type: "reply", text: resumed.text };
    }
    return {
      type: "reply",
      text: [
        `已绑定 **${key.backendId}** provider session 到当前会话：`,
        `- id: \`${picked.id}\``,
        `- cwd: ${picked.cwd}`,
        ...(picked.additionalDirectories?.length
          ? [`- additionalDirectories: ${picked.additionalDirectories.join(", ")}`]
          : []),
        `- preview: ${picked.preview}`,
        "",
        "下一条消息将通过 ACP 继续该 session。",
      ].join("\n"),
    };
  }

  if (arg.toLowerCase() === "last") {
    const sessions = await ctx.listSessions();
    const picked = sessions[0];
    if (!picked) {
      return {
        type: "reply",
        text: `当前目录 \`${key.cwd}\` 下没有找到 **${key.backendId}** 本地 session。`,
      };
    }
    const resolved = canonicalDirectory(picked.cwd);
    if ("error" in resolved) {
      return { type: "reply", text: resolved.error };
    }
    ctx.router.setBinding(
      ctx.chatId,
      {
        cwd: resolved.cwd,
        additionalDirectories: picked.additionalDirectories ?? [],
      },
      ctx.topicId,
    );
    const resumed = await resumeBoundSession(ctx, picked.id);
    if (!resumed.ok) {
      return { type: "reply", text: resumed.text };
    }
    return {
      type: "reply",
      text: [
        `已绑定最近一条 **${key.backendId}** provider session：`,
        `- id: \`${picked.id}\``,
        `- preview: ${picked.preview}`,
        ...(picked.additionalDirectories?.length
          ? [`- additionalDirectories: ${picked.additionalDirectories.join(", ")}`]
          : []),
        "",
        "下一条消息将通过 ACP 继续该 session。",
      ].join("\n"),
    };
  }

  if (arg && arg.toLowerCase() !== "all") {
    return {
      type: "reply",
      text: "用法: `/resume` | `/resume <N>` | `/resume last` | `/resume all`",
    };
  }

  const sessions = await ctx.listSessions({ all: listAll });
  const rec = ctx.router.getSessionRecord(key);
  if (sessions.length === 0) {
    const bound = rec?.sessionId
      ? `\n当前已绑定: \`${rec.sessionId}\``
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
  const boundLine = rec?.sessionId ? rec.sessionId : undefined;
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

  if (arg.toLowerCase() === "default") {
    ctx.router.clearModel(ctx.chatId, ctx.topicId);
    const fallback = profile?.model ?? "(ACP 默认)";
    return {
      type: "reply",
      text: `已清除会话 model 覆盖，将使用: ${fallback}`,
    };
  }

  const loaded = await loadConfigOption(ctx, "model", "model");
  if ("reply" in loaded) return loaded.reply;
  const runOpts = ctx.router.resolveRunOptions(
    ctx.chatId,
    ctx.topicId,
    ctx.config,
  );
  if (!arg || arg.toLowerCase() === "list") {
    return {
      type: "reply",
      text: formatDynamicModelHelp(backendId, loaded.option, runOpts.model),
    };
  }
  const value = matchBackendConfigValue(loaded.option, arg);
  if (!value) return invalidLiveValue("model", arg, loaded.option);
  ctx.router.setBinding(ctx.chatId, { model: value }, ctx.topicId);
  return {
    type: "reply",
    text: `已设置 **${backendId}** model: \`${value}\`\n下一条消息生效。`,
  };
}

async function handleEffort(
  ctx: SlashContext,
  arg: string,
): Promise<SlashResult> {
  const binding = ctx.router.getBinding(ctx.chatId, ctx.topicId);
  const backendId = binding.backendId;
  const profile = ctx.config.backends[backendId];

  if (arg.toLowerCase() === "default") {
    ctx.router.clearEffort(ctx.chatId, ctx.topicId);
    const fallback = profile?.effort ?? "(ACP 默认)";
    return {
      type: "reply",
      text: `已清除会话 effort 覆盖，将使用: ${fallback}`,
    };
  }

  const loaded = await loadConfigOption(ctx, "thought_level", "effort");
  if ("reply" in loaded) return loaded.reply;
  const runOpts = ctx.router.resolveRunOptions(
    ctx.chatId,
    ctx.topicId,
    ctx.config,
  );
  if (!arg || arg.toLowerCase() === "list") {
    return {
      type: "reply",
      text: formatDynamicOptionHelp(
        backendId,
        "effort",
        "effort",
        loaded.option,
        runOpts.effort,
      ),
    };
  }
  const value = matchBackendConfigValue(loaded.option, arg);
  if (!value) return invalidLiveValue("effort", arg, loaded.option);
  ctx.router.setBinding(ctx.chatId, { effort: value }, ctx.topicId);
  return {
    type: "reply",
    text: `已设置 **${backendId}** effort: \`${value}\`\n下一条消息生效。`,
  };
}

async function handlePermission(
  ctx: SlashContext,
  arg: string,
): Promise<SlashResult> {
  const binding = ctx.router.getBinding(ctx.chatId, ctx.topicId);
  const backendId = binding.backendId;
  const profile = ctx.config.backends[backendId];

  if (arg.toLowerCase() === "default") {
    ctx.router.clearMode(ctx.chatId, ctx.topicId);
    ctx.router.clearClaudePermissionMode(ctx.chatId, ctx.topicId);
    const policy = ctx.config.runnerHost?.acpPermissionPolicy ?? "auto_allow";
    const fallback =
      profile?.claudePermissionMode ??
      (backendId === "claude"
        ? policy === "auto_allow"
          ? "bypassPermissions（Runner auto_allow）"
          : "default（由 Runner 处理权限请求）"
        : "ACP 适配器默认 mode");
    return {
      type: "reply",
      text: `已清除会话 permission 覆盖，将使用: ${fallback}`,
    };
  }

  const loaded = await loadConfigOption(ctx, "mode", "mode/permission");
  if ("reply" in loaded) return loaded.reply;
  const runOpts = ctx.router.resolveRunOptions(
    ctx.chatId,
    ctx.topicId,
    ctx.config,
  );
  if (!arg || arg.toLowerCase() === "list") {
    const help = formatDynamicOptionHelp(
      backendId,
      "mode/permission",
      "permission",
      loaded.option,
      runOpts.mode,
    );
    const policy = ctx.config.runnerHost?.acpPermissionPolicy ?? "auto_allow";
    return {
      type: "reply",
      text: `${help}\n\nRunner approval policy: \`${policy}\`（控制 ACP 权限请求如何批准；与 adapter mode 共同生效）`,
    };
  }
  const value = matchBackendConfigValue(loaded.option, arg);
  if (!value) return invalidLiveValue("mode/permission", arg, loaded.option);
  ctx.router.setBinding(ctx.chatId, { mode: value }, ctx.topicId);
  return {
    type: "reply",
    text: `已设置 **${backendId}** mode/permission: \`${value}\`\n下一条消息生效。`,
  };
}

async function loadConfigOption(
  ctx: SlashContext,
  category: string,
  label: string,
): Promise<{ option: BackendConfigOption } | { reply: SlashResult }> {
  const backendId = ctx.router.getBinding(ctx.chatId, ctx.topicId).backendId;
  if (!ctx.listConfigOptions) {
    return {
      reply: { type: "reply", text: "Runner 未就绪，无法读取 ACP 实时能力。" },
    };
  }
  try {
    const options = await ctx.listConfigOptions();
    const option = options.find(
      (candidate) =>
        candidate.category === category && candidate.values.length > 0,
    );
    if (!option) {
      return {
        reply: {
          type: "reply",
          text: `**${backendId}** ACP 适配器未提供 ${label} 配置项。`,
        },
      };
    }
    return { option };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      reply: {
        type: "reply",
        text: `ACP 实时能力读取失败：${message}`,
      },
    };
  }
}

function invalidLiveValue(
  label: string,
  input: string,
  option: BackendConfigOption,
): SlashResult {
  const values = option.values.map((value) => value.name ?? value.value);
  return {
    type: "reply",
    text: `${label} \`${input}\` 不在适配器实时列表中。\n可选: ${values.join(", ")}`,
  };
}

function handleThinking(ctx: SlashContext, arg: string): SlashResult {
  const current = ctx.router.getBinding(ctx.chatId, ctx.topicId).showThinking ?? true;
  const a = arg.trim().toLowerCase();

  if (!a || a === "list" || a === "status") {
    return {
      type: "reply",
      text: [
        `思考过程展示: ${current ? "**on**（显示思考与工具调用过程）" : "**off**（隐藏内部思考/工具，保留进度与最终答案）"}`,
        "",
        "用法: `/thinking on|off`",
      ].join("\n"),
    };
  }

  const on = ["on", "开", "show", "true", "1"].includes(a);
  const off = ["off", "关", "hide", "false", "0"].includes(a);
  if (!on && !off) {
    return {
      type: "reply",
      text: `无效参数: ${arg}\n用法: \`/thinking on|off\`（当前: ${current ? "on" : "off"}）`,
    };
  }

  ctx.router.setBinding(ctx.chatId, { showThinking: on }, ctx.topicId);
  return {
    type: "reply",
    text: on
      ? "已开启思考过程展示：卡片会显示思考与工具调用过程，`---` 分隔线之后是最终答案。"
      : "已关闭思考过程展示：隐藏内部思考与工具过程，保留进度检查点和最终答案。下一条消息生效。",
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
    const resolved = canonicalDirectory(cwd);
    if ("error" in resolved) {
      return { type: "reply", text: resolved.error };
    }
    ctx.router.setBinding(ctx.chatId, { cwd: resolved.cwd }, ctx.topicId);
    ctx.router.clearSession(ctx.chatId, ctx.topicId);
    return { type: "reply", text: `已切换工作区: ${name} (${resolved.cwd})` };
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
