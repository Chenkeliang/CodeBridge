import { z } from "zod";

export const PolicyScenarioSchema = z.object({
  name: z.string(),
  chats: z.array(z.string()),
  requireMention: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export const FeishuPolicySchema = z.object({
  requireMention: z.boolean().default(true),
  dmMode: z.enum(["open", "disabled", "allowlist", "pair"]).default("open"),
  dmAllowlist: z.array(z.string()).optional(),
  groupAllowlist: z.array(z.string()).optional(),
  respondToMentionAll: z.boolean().default(false),
  scenarios: z.array(PolicyScenarioSchema).optional(),
});

export const BackendProfileSchema = z.object({
  type: z.enum(["cursor-cli", "claude-code", "codex", "generic-spawn"]),
  transport: z.enum(["acp", "cli"]).default("acp"),
  command: z.string(),
  args: z.array(z.string()).optional(),
  acpCommand: z.string().optional(),
  acpArgs: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  allowBypassApprovals: z.boolean().optional(),
  allowBypassApprovalsViaConfig: z.boolean().optional(),
  claudeArgsOption: z.string().optional(),
  /** Claude -p 非交互模式下的权限模式，默认 bypassPermissions 避免 dontAsk 拒绝 Bash */
  claudePermissionMode: z
    .enum([
      "acceptEdits",
      "auto",
      "bypassPermissions",
      "default",
      "dontAsk",
      "plan",
    ])
    .optional(),
  codexArgsOption: z.string().optional(),
});

export const AccessConfigSchema = z.object({
  allowedUsers: z.array(z.string()).optional(),
  allowedChats: z.array(z.string()).optional(),
  admins: z.array(z.string()).optional(),
});

export const WorkspacesConfigSchema = z.object({
  root: z.string().optional(),
  default: z.string().optional(),
  named: z.record(z.string()).optional(),
});

export const ConfigSchema = z.object({
  feishu: z.object({
    domain: z.string().url().default("https://open.feishu.cn"),
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    policy: FeishuPolicySchema.optional(),
  }),
  runner: z.object({
    url: z.string().url().default("http://127.0.0.1:19789"),
    token: z.string().min(8),
  }),
  defaultBackend: z.enum(["cursor", "claude", "codex"]).default("cursor"),
  backends: z.record(BackendProfileSchema),
  access: AccessConfigSchema.optional(),
  workspaces: WorkspacesConfigSchema.optional(),
  runnerHost: z
    .object({
      listen: z.string().default("127.0.0.1:19789"),
      maxConcurrentRuns: z.number().int().positive().default(4),
      acpPermissionPolicy: z
        .enum(["auto_allow", "prompt_deny"])
        .default("auto_allow"),
      /** 一轮无结束信号的总超时（ms），到点判 fatal */
      acpPromptTimeoutMs: z
        .number()
        .int()
        .positive()
        .default(40 * 60_000),
      /** 从发 prompt 起完全无任何输出的超时（ms） */
      acpNoOutputTimeoutMs: z
        .number()
        .int()
        .positive()
        .default(10 * 60_000),
      /** 已有输出后无新事件的 stall 超时（ms），到点判 fatal（疑似工具卡死） */
      acpStallTimeoutMs: z
        .number()
        .int()
        .positive()
        .default(30 * 60_000),
      /** 主轮 stop 后续读后台子 agent 输出（drain）总开关 */
      acpDrainBackgroundWork: z.boolean().default(true),
      /** drain probe 短窗：主轮 stop 后这么久无真实后台活动则判无后台（ms） */
      acpPostStopProbeMs: z.number().int().positive().default(8_000),
      /** drain quiet 长窗：确认有后台后这么久无新活动视为后台结束（ms） */
      acpPostStopQuietMs: z.number().int().positive().default(75_000),
      /** drain 独立硬上限：后台跑这么久仍未结束则停止跟踪（ms） */
      acpPostStopMaxMs: z.number().int().positive().default(20 * 60_000),
    })
    .optional(),
  /** Bridge 本地出站 API（供 Agent 内的 fcb 命令把文件/消息发回飞书） */
  bridge: z
    .object({
      apiPort: z.number().int().positive().default(19790),
    })
    .optional(),
  plugins: z
    .object({
      memory: z.object({ enabled: z.boolean().default(false) }).optional(),
    })
    .optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type FeishuPolicy = z.infer<typeof FeishuPolicySchema>;

export function defaultConfig(): AppConfig {
  return ConfigSchema.parse({
    feishu: {
      domain: "https://open.feishu.cn",
      appId: "cli_placeholder",
      appSecret: "secret_placeholder",
      policy: {
        requireMention: true,
        dmMode: "open",
        respondToMentionAll: false,
      },
    },
    runner: {
      url: "http://127.0.0.1:19789",
      token: "change-me-runner-token",
    },
    defaultBackend: "cursor",
    backends: {
      cursor: {
        type: "cursor-cli",
        transport: "acp",
        command: "cursor-agent",
        args: ["--force", "--trust", "--approve-mcps"],
        acpCommand: "cursor-agent",
        acpArgs: ["acp"],
        model: "composer-2.5",
      },
      claude: {
        type: "claude-code",
        transport: "acp",
        command: "claude",
        acpCommand: "npx",
        acpArgs: ["-y", "@agentclientprotocol/claude-agent-acp@0.55.0"],
        model: "sonnet",
        effort: "medium",
        claudePermissionMode: "bypassPermissions",
      },
      codex: {
        type: "codex",
        transport: "acp",
        command: "codex",
        acpCommand: "npx",
        acpArgs: ["-y", "@agentclientprotocol/codex-acp@1.1.4"],
        // 不钉 model：OpenAI 轮换模型名很快，钉了必过期；用适配器默认，会话内 /model 切
        allowBypassApprovals: false,
        allowBypassApprovalsViaConfig: true,
      },
    },
    workspaces: {
      root: `${process.env.HOME ?? ""}/Projects`,
    },
  });
}

/** Resolve effective requireMention for a chat (scenarios override global). */
export function resolveRequireMention(
  policy: FeishuPolicy | undefined,
  chatId: string,
): boolean {
  const base = policy?.requireMention ?? true;
  if (!policy?.scenarios?.length) return base;
  for (const scenario of policy.scenarios) {
    if (!scenario.chats.includes(chatId)) continue;
    if (scenario.enabled === false) return false;
    if (scenario.requireMention !== undefined) return scenario.requireMention;
  }
  return base;
}
