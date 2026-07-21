export interface CommandHelpItem {
  command: string;
  summary: string;
}

export const SLASH_COMMANDS: CommandHelpItem[] = [
  { command: "/help", summary: "查看全部命令" },
  { command: "/menu", summary: "快捷命令面板（同 /help）" },
  { command: "/stop", summary: "停止当前正在执行的 Agent 任务（别名 /cancel）" },
  { command: "/approve", summary: "允许 Agent 挂起的权限请求（prompt_feishu 模式）" },
  { command: "/deny", summary: "拒绝 Agent 挂起的权限请求" },
  { command: "/status", summary: "查看当前 backend / cwd / model 等全部会话状态" },
  { command: "/new", summary: "新建会话（别名 /reset）" },
  { command: "/resume", summary: "列出本机 session" },
  { command: "/resume <N>", summary: "绑定第 N 条 session" },
  { command: "/resume last", summary: "绑定最近一条" },
  { command: "/resume all", summary: "列出本机全部 session（不限当前目录）" },
  { command: "/backend <名>", summary: "cursor | claude | codex" },
  { command: "/cd <path>", summary: "切换项目目录" },
  { command: "/ws list", summary: "列出命名工作区" },
  { command: "/ws save <名>", summary: "保存当前目录为工作区" },
  { command: "/ws use <名>", summary: "切换到已保存工作区" },
  { command: "/ws remove <名>", summary: "删除命名工作区" },
  { command: "/model [名|default]", summary: "切换模型" },
  { command: "/transport [acp|cli|default]", summary: "切换 ACP / CLI 传输" },
  { command: "/effort [级|default]", summary: "Claude effort" },
  {
    command: "/permission [模式|default]",
    summary: "Claude 权限模式（bypassPermissions 等，别名 /perm）",
  },
  {
    command: "/thinking [on|off]",
    summary: "卡片是否显示思考/工具过程（默认 on，别名 /think）",
  },
  { command: "/send <path>", summary: "把本机文件发到当前聊天" },
  { command: "/clone <url>", summary: "git clone" },
  { command: "/pull", summary: "git pull" },
  { command: "/config", summary: "查看配置摘要（policy / defaultBackend / runner）" },
];

/** 飞书机器人自定义菜单 event_key → 模拟用户发送的文本 */
export const BOT_MENU_EVENT_KEYS: Record<string, string> = {
  fcb_help: "/help",
  fcb_status: "/status",
  fcb_resume: "/resume",
  fcb_new: "/new",
  fcb_stop: "/stop",
  fcb_backend_cursor: "/backend cursor",
  fcb_backend_claude: "/backend claude",
  fcb_ws_list: "/ws list",
};

export function formatFullCommandHelp(): string {
  const lines = SLASH_COMMANDS.map(
    (item) => `\`${item.command}\` — ${item.summary}`,
  );
  return ["**飞书码桥命令**", "", ...lines].join("\n");
}

export function formatWelcomeMessage(botName = "飞书码桥"): string {
  const quick = [
    "`/status` 查看状态",
    "`/resume` 续聊本机 session",
    "`/backend claude` 切换 Agent",
    "`/help` 全部命令",
  ];
  return [
    `👋 欢迎使用 **${botName}**`,
    "",
    "在飞书里远程驱动本机 Cursor / Claude Code / Codex。",
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
  return "快捷：`/help` · `/status` · `/resume` · `/stop` · `/new` · `/backend`";
}

export function formatBotMenuSetupGuide(): string[] {
  return [
    "建议在飞书开放平台 → 机器人 → 自定义菜单 中配置（单聊）：",
    "  · 展示样式：悬浮菜单",
    "  · 动作类型：发送文字 或 推送事件",
    "  · 发送文字示例：/status、/resume、/new",
    "  · 推送事件 event_key 见 docs/zh-CN/feishu-bot-menu.md",
    "  · 订阅事件：application.bot.menu_v6、im.chat.access_event.bot_p2p_chat_entered_v1",
  ];
}
