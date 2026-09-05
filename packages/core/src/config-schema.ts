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

/** Web Rail / 飞书 `/backend` 共用的五家 Agent，不再扩张。 */
export const SUPPORTED_AGENT_IDS = [
  "cursor",
  "claude",
  "codex",
  "pi",
  "opencode",
] as const;
export type SupportedAgentId = (typeof SUPPORTED_AGENT_IDS)[number];

export const BackendProfileSchema = z.object({
  type: z.enum(["cursor-cli", "claude-code", "codex", "generic-spawn", "pi-sdk"]),
  // 兼容旧配置里的显式 `transport: acp`；CLI transport 已移除；pi-sdk 不读取该字段。
  transport: z.literal("acp").optional(),
  acpCommand: z.string().optional(),
  acpArgs: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  /** Claude ACP mode 的兼容默认值，默认 bypassPermissions 避免 dontAsk 拒绝 Bash */
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
});

export const DEFAULT_BACKEND_PROFILES: Record<
  SupportedAgentId,
  z.infer<typeof BackendProfileSchema>
> = {
  cursor: {
    type: "cursor-cli",
    acpCommand: "cursor-agent",
    acpArgs: ["acp"],
  },
  claude: {
    type: "claude-code",
    acpCommand: "npx",
    acpArgs: ["-y", "@agentclientprotocol/claude-agent-acp@0.64.2"],
    claudePermissionMode: "bypassPermissions",
  },
  codex: {
    type: "codex",
    acpCommand: "npx",
    acpArgs: ["-y", "@agentclientprotocol/codex-acp@1.10.0"],
  },
  pi: { type: "pi-sdk" },
  opencode: {
    type: "generic-spawn",
    acpCommand: "opencode",
    acpArgs: ["acp"],
  },
};

function mergeDefaultBackends(
  backends: Record<string, z.infer<typeof BackendProfileSchema>>,
): Record<string, z.infer<typeof BackendProfileSchema>> {
  return { ...DEFAULT_BACKEND_PROFILES, ...backends };
}

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

export const ProjectCatalogConfigSchema = z.object({
  repositoryPath: z.string().min(1),
  baseRef: z.string().min(1).default("main"),
  catalogPath: z.string().min(1).default("catalog/projects.yaml"),
});

const McpServerCommonSchema = {
  revision: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
};

export const McpServerConfigSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.array(z.string().min(1)).optional(),
    ...McpServerCommonSchema,
  }),
  z.object({
    transport: z.literal("http"),
    url: z.string().url(),
    ...McpServerCommonSchema,
  }),
]);

export const SessionRuntimeConfigSchema = z.object({
  maxQueuedTurns: z.number().int().min(1).max(1_000).default(100),
});

export const OrchestrationConfigSchema = z.object({
  projectCatalog: ProjectCatalogConfigSchema.optional(),
  mcpServers: z.record(McpServerConfigSchema).optional(),
  session: SessionRuntimeConfigSchema.optional(),
});

export const ConfigSchema = z.object({
  feishu: z.object({
    domain: z.string().url().default("https://open.feishu.cn"),
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    policy: FeishuPolicySchema.optional(),
  }),
  telegram: z
    .object({
      botToken: z.string().min(1),
      allowedUsers: z.array(z.string()).optional(),
      allowedChats: z.array(z.string()).optional(),
      pollingTimeoutSec: z.number().int().min(1).max(50).default(25),
    })
    .optional(),
  runner: z.object({
    url: z.string().url().default("http://127.0.0.1:19789"),
    token: z.string().min(8),
  }),
  web: z
    .object({
      /** The Web surface is opt-in; channels and Core API remain independent. */
      enabled: z.boolean().default(false),
      /** Optional absolute path to the built React application. */
      staticDirectory: z.string().min(1).optional(),
    })
    .default({ enabled: false }),
  defaultAgent: z.string().min(1).optional(),
  defaultBackend: z.enum(SUPPORTED_AGENT_IDS).default("cursor"),
  backends: z.record(BackendProfileSchema).transform(mergeDefaultBackends),
  access: AccessConfigSchema.optional(),
  workspaces: WorkspacesConfigSchema.optional(),
  orchestration: OrchestrationConfigSchema.optional(),
  runnerHost: z
    .object({
      listen: z.string().default("127.0.0.1:19789"),
      maxConcurrentRuns: z.number().int().positive().default(4),
      /** auto_allow=全放行；prompt_deny=一律拒绝；prompt_feishu=在飞书里等 /approve /deny（超时拒绝） */
      acpPermissionPolicy: z
        .enum(["auto_allow", "prompt_deny", "prompt_feishu"])
        .default("auto_allow"),
      /** 一轮无结束信号的总超时（ms）；长任务可运行 6 小时，和停滞检测分开 */
      acpPromptTimeoutMs: z
        .number()
        .int()
        .positive()
        .default(6 * 60 * 60_000),
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
      /** 长驻会话池总开关：同会话消息复用适配器进程，省每轮 2-4s 冷启动 */
      acpSessionPool: z.boolean().default(true),
      /** 池内空闲会话进程的回收时限（ms） */
      acpSessionIdleMs: z
        .number()
        .int()
        .positive()
        .default(10 * 60_000),
      /** 池内最多保留多少个空闲会话进程 */
      acpSessionPoolMax: z.number().int().positive().default(4),
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

/** Web 设置页的 defaultAgent 优先；没有再回退到 defaultBackend。 */
export function resolveDefaultAgentId(
  config: Pick<AppConfig, "defaultAgent" | "defaultBackend" | "backends">,
): string {
  const preferred = config.defaultAgent?.trim();
  if (preferred && config.backends[preferred]) return preferred;
  if (config.defaultBackend && config.backends[config.defaultBackend]) {
    return config.defaultBackend;
  }
  for (const id of SUPPORTED_AGENT_IDS) {
    if (config.backends[id]) return id;
  }
  return Object.keys(config.backends)[0] ?? "cursor";
}

export function isSupportedAgentId(id: string): id is SupportedAgentId {
  return (SUPPORTED_AGENT_IDS as readonly string[]).includes(id);
}

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
    web: {
      enabled: false,
    },
    defaultAgent: undefined,
    defaultBackend: "cursor",
    backends: DEFAULT_BACKEND_PROFILES,
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
