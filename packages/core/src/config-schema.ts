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
  command: z.string(),
  args: z.array(z.string()).optional(),
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
      cursor: { type: "cursor-cli", command: "cursor-agent", args: ["--force"] },
      claude: {
        type: "claude-code",
        command: "claude",
        claudePermissionMode: "bypassPermissions",
      },
      codex: {
        type: "codex",
        command: "codex",
        model: "gpt-5.1-codex",
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
