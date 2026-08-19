export interface CommandHelpItem {
  command: string;
  summary: string;
}

export type CommandHelpFormat = "markdown" | "plain";

interface CommandHelpGroup {
  title: string;
  items: CommandHelpItem[];
}

const COMMAND_HELP_GROUPS: CommandHelpGroup[] = [
  {
    title: "常用",
    items: [
      { command: "/help [full]", summary: "查看快捷菜单或全部命令" },
      { command: "/menu", summary: "查看手机快捷菜单" },
      { command: "/status", summary: "查看 backend、目录、模型和任务状态（别名 /s）" },
    ],
  },
  {
    title: "任务控制",
    items: [
      { command: "/stop", summary: "停止当前 Agent 任务（别名 /cancel、/x）" },
      { command: "/continue", summary: "恢复暂停队列（别名 /c）" },
      { command: "/steer <指令>", summary: "向运行中的 ACP turn 注入补充指令" },
      { command: "/approve", summary: "允许当前挂起的权限请求（别名 /a）" },
      { command: "/deny", summary: "拒绝当前挂起的权限请求（别名 /d）" },
    ],
  },
  {
    title: "会话管理",
    items: [
      { command: "/new", summary: "新建会话（别名 /reset）" },
      { command: "/resume", summary: "列出当前目录的本机 session（别名 /r）" },
      { command: "/resume <N>", summary: "绑定列表中第 N 条 session" },
      { command: "/resume last", summary: "绑定最近一条 session" },
      { command: "/resume all", summary: "列出全部目录的本机 session" },
      { command: "/session close <sessionId>", summary: "关闭指定 ACP session" },
      { command: "/session delete <sessionId>", summary: "永久删除指定 ACP session" },
    ],
  },
  {
    title: "Agent 与模型",
    items: [
      { command: "/backend <cursor|claude|codex|pi|opencode|default>", summary: "切换 Agent（别名 /b）" },
      { command: "/transport", summary: "兼容命令；当前仅支持 ACP，无需切换" },
      { command: "/model [list|名称|default]", summary: "列出或切换实时模型" },
      { command: "/effort [list|级别|default]", summary: "列出或切换实时推理强度" },
      {
        command: "/permission [list|模式|default]",
        summary: "列出或切换实时 mode/权限（别名 /perm）",
      },
      { command: "/config [id value|default]", summary: "查看或设置 ACP 实时配置（含 boolean）" },
      { command: "/thinking [on|off]", summary: "显示或隐藏思考/工具过程（别名 /think）" },
    ],
  },
  {
    title: "目录与工作区",
    items: [
      { command: "/cd <绝对路径>", summary: "切换项目目录" },
      { command: "/roots", summary: "列出 ACP 附加目录" },
      { command: "/root add|remove|rm <绝对路径>", summary: "管理 ACP 附加目录" },
      { command: "/ws list", summary: "列出命名工作区" },
      { command: "/ws save <名称>", summary: "保存当前目录为工作区" },
      { command: "/ws use <名称>", summary: "切换到命名工作区" },
      { command: "/ws remove <名称>", summary: "删除命名工作区" },
    ],
  },
  {
    title: "文件与 Git",
    items: [
      { command: "/send <文件路径>", summary: "把本机文件发到当前聊天" },
      { command: "/clone <git-url> [目录名]", summary: "克隆仓库并切换目录" },
      { command: "/pull", summary: "在当前目录执行 git pull --ff-only" },
    ],
  },
];

export const SLASH_COMMANDS: CommandHelpItem[] = COMMAND_HELP_GROUPS.flatMap(
  (group) => group.items,
);

const COMPACT_COMMANDS: CommandHelpItem[] = [
  { command: "/s", summary: "查看当前状态（/status）" },
  { command: "/c", summary: "恢复暂停队列（/continue）" },
  { command: "/r last", summary: "续聊最近会话（/resume last）" },
  { command: "/new", summary: "新建会话" },
  { command: "/x", summary: "停止当前任务（/stop）" },
  { command: "/b", summary: "切换 Agent（cursor / claude / codex / pi / opencode）" },
  { command: "/model", summary: "查看或切换模型" },
  { command: "/permission", summary: "查看或切换权限" },
  { command: "/ws list", summary: "查看工作区" },
];

/** 飞书机器人自定义菜单 event_key → 模拟用户发送的文本 */
export const BOT_MENU_EVENT_KEYS: Record<string, string> = {
  fcb_help: "/help",
  fcb_status: "/status",
  fcb_resume: "/resume",
  fcb_resume_last: "/resume last",
  fcb_new: "/new",
  fcb_stop: "/stop",
  fcb_backend_cursor: "/backend cursor",
  fcb_backend_claude: "/backend claude",
  fcb_backend_codex: "/backend codex",
  fcb_model: "/model",
  fcb_permission: "/permission",
  fcb_ws_list: "/ws list",
};

function heading(text: string, format: CommandHelpFormat): string {
  return format === "markdown" ? `**${text}**` : text;
}

function commandLine(
  item: CommandHelpItem,
  format: CommandHelpFormat,
): string {
  const command = format === "markdown" ? `\`${item.command}\`` : item.command;
  return `${command} — ${item.summary}`;
}

export function formatCompactCommandHelp(
  format: CommandHelpFormat = "markdown",
): string {
  return [
    heading("码桥快捷菜单", format),
    "",
    ...COMPACT_COMMANDS.map((item) => commandLine(item, format)),
    "",
    commandLine(
      { command: "/help full", summary: "查看全部命令" },
      format,
    ),
  ].join("\n");
}

export function formatFullCommandHelp(
  format: CommandHelpFormat = "markdown",
): string {
  const lines = [heading("码桥全部命令", format)];
  for (const group of COMMAND_HELP_GROUPS) {
    lines.push(
      "",
      heading(group.title, format),
      ...group.items.map((item) => commandLine(item, format)),
    );
  }
  return lines.join("\n");
}

export function formatWelcomeMessage(botName = "CodeBridge"): string {
  const quick = [
    "`/s` 查看状态（`/status`）",
    "`/r last` 续聊最近 session（`/resume last`）",
    "`/b` 切换 Agent（`/backend`：cursor / claude / codex / pi / opencode）",
    "`/menu` 快捷菜单",
  ];
  return [
    `👋 欢迎使用 **${botName}**`,
    "",
    "在飞书里远程驱动本机 Cursor / Claude Code / Codex / Pi / OpenCode。",
    "直接发消息开始；也可用斜杠命令：",
    "",
    ...quick.map((line) => `- ${line}`),
    "",
    "---",
    "💡 在飞书开放平台为机器人配置**自定义菜单**后，常用命令可固定在输入框上方。",
    "配置说明见项目 `docs/zh-CN/feishu-bot-menu.md`",
  ].join("\n");
}

export function formatCompactCommandHint(): string {
  return "快捷：`/menu` · `/s` · `/c` · `/r last` · `/x` · `/new` · `/b`";
}

export function formatBotMenuSetupGuide(): string[] {
  return [
    "建议在飞书开放平台 → 机器人 → 自定义菜单 中配置（单聊）：",
    "  · 展示样式：悬浮菜单",
    "  · 动作类型：发送文字 或 推送事件",
    "  · 发送文字示例：/status、/resume last、/new",
    "  · 推送事件 event_key 见 docs/zh-CN/feishu-bot-menu.md",
    "  · 订阅事件：application.bot.menu_v6、im.chat.access_event.bot_p2p_chat_entered_v1",
  ];
}
