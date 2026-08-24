import { useState } from "react";
import { CommandPalette } from "@/components/command-palette";
import { Composer } from "@/components/composer";
import { LoadingConversation, ProjectionItem } from "@/components/conversation";
import { AgentRail, SessionHeader, SessionPanel } from "@/components/session-chrome";
import { SkillControlPlanePage } from "@/components/skill-control-plane";
import type { ConversationProjection } from "@/lib/events";
import type { AgentCommand, AgentProfile, AgentSession, ApprovalRecord, ConfigOption, FlowRecord } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { Density, MenuView, PanelArea, Theme } from "@/components/workbench-shared";

/**
 * Design preview rendered with the real workbench components fed by mock
 * data (allowed per DESIGN.md §9: demo data only lives behind this explicit
 * preview entry). Open with `/workbench/?preview=design`.
 */

const agents: AgentProfile[] = [
  { agent_id: "codex", display_name: "Codex", adapter: "acp", status: "healthy", capabilities: [], models: [], session_features: [], setup: { installation: "installed", configuration: "configured", runtime: "healthy", can_select_default: true, can_create_session: true }, setup_manifest: { agent_id: "codex", display_name: "Codex", adapter: "acp", install_strategies: [{ id: "npm-global", label: "Install Codex globally", command: "npm", args: ["install", "-g", "@openai/codex"], available: true, requires_confirmation: true }], configuration_owner: "agent", documentation_url: "https://developers.openai.com/codex/", supports_managed_configuration: false } },
  { agent_id: "pi", display_name: "Pi", adapter: "sdk", status: "healthy", capabilities: [], models: [], session_features: [], setup: { installation: "installed", configuration: "configured", runtime: "healthy", can_select_default: true, can_create_session: true }, setup_manifest: { agent_id: "pi", display_name: "Pi", adapter: "sdk", install_strategies: [], configuration_owner: "codebridge", configuration_path: "~/.pi/agent/models.json", documentation_url: "https://docs.orchestration/agent-providers#pi", supports_managed_configuration: true } },
  { agent_id: "cursor", display_name: "Cursor", adapter: "acp", status: "needs_setup", capabilities: [], models: [], session_features: [], setup: { installation: "missing", configuration: "unknown", runtime: "not_started", can_select_default: false, can_create_session: false }, setup_manifest: { agent_id: "cursor", display_name: "Cursor", adapter: "acp", install_strategies: [], configuration_owner: "agent", documentation_url: "https://cursor.com/", supports_managed_configuration: false } },
  { agent_id: "claude", display_name: "Claude Code", adapter: "acp", status: "needs_setup", capabilities: [], models: [], session_features: [], setup: { installation: "installed", configuration: "needs_configuration", runtime: "not_started", can_select_default: false, can_create_session: false }, setup_manifest: { agent_id: "claude", display_name: "Claude Code", adapter: "acp", install_strategies: [{ id: "npm-global", label: "Install Claude Code globally", command: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"], available: true, requires_confirmation: true }], configuration_owner: "agent", documentation_url: "https://docs.anthropic.com/en/docs/claude-code", supports_managed_configuration: false } },
  { agent_id: "opencode", display_name: "OpenCode", adapter: "acp", status: "unavailable", capabilities: [], models: [], session_features: [], setup: { installation: "installed", configuration: "configured", runtime: "unavailable", can_select_default: true, can_create_session: false }, setup_manifest: { agent_id: "opencode", display_name: "OpenCode", adapter: "acp", install_strategies: [{ id: "npm-global", label: "Install OpenCode globally", command: "npm", args: ["install", "-g", "opencode-ai"], available: true, requires_confirmation: true }], configuration_owner: "agent", configuration_path: "~/.config/opencode/opencode.json", documentation_url: "https://opencode.ai/docs/cli/", supports_managed_configuration: false } },
];

function mockSession(id: string, agentId: string, title: string | null, status: string, minutesAgo: number, pinned = false): AgentSession {
  const updated = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    session_id: id,
    agent_id: agentId,
    provider_session_id: null,
    task_record_id: null,
    flow_id: null,
    flow_definition_revision: null,
    model: null,
    effort: null,
    permission_mode: null,
    cwd: "/Users/demo/projects/codebridge",
    additional_directories: [],
    title,
    status,
    pinned_at: pinned ? updated : null,
    archived_at: null,
    created_at: updated,
    updated_at: updated,
  };
}

const sessions: AgentSession[] = [
  mockSession("s1", "codex", "Session 切换性能排查", "active", 0, true),
  mockSession("s2", "codex", "Provider 历史合并 Review", "idle", 47),
  mockSession("s3", "codex", "工作台交互走查", "idle", 132),
  mockSession("s4", "codex", null, "closed", 60 * 26),
];

const flows: FlowRecord[] = [
  { flow_id: "f1", name: "仓库巡检", description: null, kind: "runbook", status: "published", source: "catalog", definition_revision: "3", plan_ir_hash: null, inputs: [], steps: [], review_status: null, git_revision: null, validation_issues: [], lineage_root_flow_id: "f1", parent_flow_id: null, provenance: null, publication_sequence: 1, created_at: "2026-08-21T00:00:00.000Z", updated_at: "2026-08-21T00:00:00.000Z" },
  { flow_id: "f2", name: "发布验证", description: null, kind: "guide", status: "draft", source: "catalog", definition_revision: "1", plan_ir_hash: null, inputs: [], steps: [], review_status: null, git_revision: null, validation_issues: [], lineage_root_flow_id: "f2", parent_flow_id: null, provenance: null, publication_sequence: 0, created_at: "2026-08-21T00:00:00.000Z", updated_at: "2026-08-21T00:00:00.000Z" },
];

const commands: AgentCommand[] = [
  { name: "plan", description: "先产出计划再执行" },
  { name: "review", description: "对当前变更做代码审查", input: { hint: "路径或分支" } },
];

const modelOption: ConfigOption = {
  id: "model",
  name: "模型",
  type: "select",
  category: "model",
  currentValue: "gpt-5.4",
  values: [
    { value: "gpt-5.4", name: "GPT-5.4", description: "默认模型" },
    { value: "gpt-5.4-mini", name: "GPT-5.4 mini", description: "更快、更便宜" },
  ],
};

const thoughtLevelOption: ConfigOption = {
  id: "reasoning",
  name: "推理强度",
  type: "select",
  category: "thought_level",
  currentValue: "medium",
  values: [
    { value: "low", name: "低" },
    { value: "medium", name: "中" },
    { value: "high", name: "高" },
    { value: "max", name: "最高" },
  ],
};

const speedOption: ConfigOption = {
  id: "fast-mode",
  name: "Fast mode",
  type: "boolean",
  category: "model_config",
  currentValue: "false",
  values: [
    { value: "false", name: "Standard" },
    { value: "true", name: "Fast", description: "响应更快，配额消耗更高" },
  ],
};

const permissionOption: ConfigOption = {
  id: "permission-mode",
  name: "权限",
  type: "select",
  category: "mode",
  values: [
    { value: "auto", name: "自动", description: "自动放行低风险操作" },
    { value: "strict", name: "严格", description: "所有写入都需审批" },
  ],
};

const now = Date.now();
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const projections: ConversationProjection[] = [
  { kind: "user", content: "分析当前 Session 切换链路，并确认下一步需要哪些上下文。", eventId: "e1" },
  {
    kind: "work",
    id: "w1",
    startedAt: minutesAgo(2),
    endedAt: minutesAgo(1),
    runId: "r1",
    running: false,
    entries: [
      { kind: "thought", content: "先检查 Session、事件、资源加载和 Provider 恢复四段链路。" },
      { kind: "tool", id: "t1", name: "exec_command", status: "completed", input: { cmd: "pnpm test" }, output: "Tests 47 passed (47)", runId: "r1" },
      { kind: "tool", id: "t2", name: "read_file", status: "completed", locations: [{ path: "/Users/demo/projects/codebridge/apps/web/src/lib/events.ts" }], runId: "r1" },
      {
        kind: "tool",
        id: "t3",
        name: "edit_file",
        status: "completed",
        locations: [{ path: "/Users/demo/projects/codebridge/apps/web/src/lib/events.ts" }],
        input: { old_string: 'return "就绪";', new_string: 'return status === "idle" ? "" : "就绪";' },
        runId: "r1",
      },
    ],
  },
  {
    kind: "plan",
    runId: "r1",
    entries: [
      { content: "梳理事件投影链路", priority: "high", status: "completed" },
      { content: "验证 Provider 会话集合", priority: "medium", status: "in_progress" },
      { content: "输出下一步建议", priority: "medium", status: "pending" },
    ],
  },
  {
    kind: "assistant",
    phase: "final_answer",
    runId: "r1",
    content: "入口追踪已完成。**结论**:Session 切换由 `History → Commands → Config → Live Events` 四段组成，恢复逻辑集中在 `restoreSessionSelection`。\n\n```ts\n// 恢复上次选择的 Session\nconst remembered = localStorage.getItem(`codebridge:last-session:${agentId}`);\n```\n\n下一步需要确认 Provider 侧的会话集合。",
  },
  { kind: "approval", requestId: "ap1", title: "允许在当前目录写入文件：apps/web/src/lib/events.ts", runId: "r1" },
];

const runningWork: ConversationProjection = {
  kind: "work",
  id: "w2",
  startedAt: minutesAgo(1),
  endedAt: minutesAgo(1),
  runId: "r2",
  running: true,
  entries: [
    { kind: "thought", content: "正在验证 Provider 侧的会话集合…" },
    { kind: "tool", id: "t4", name: "exec_command", status: "running", input: { cmd: "pnpm test -- --watch" }, runId: "r2" },
  ],
};

const approvals: ApprovalRecord[] = [{
  id: "ap1",
  run_id: "r1",
  step_id: "step-1",
  capability_id: "fs.write",
  session_id: "s1",
  environment: "local",
  target_resource: "apps/web/src/lib/events.ts",
  status: "requested",
  created_at: minutesAgo(1),
  expires_at: null,
}];

const stateShowcase: Array<{ title: string; node: React.ReactNode }> = [
  { title: "加载中（像素 skeleton）", node: <LoadingConversation /> },
  { title: "进行中的 Work（实时计时 + 呼吸节点）", node: <ProjectionItem approvals={[]} cwd="/Users/demo/projects/codebridge" item={runningWork} onApproval={async () => undefined} /> },
  { title: "错误", node: <ProjectionItem approvals={[]} cwd={null} item={{ kind: "error", content: "会话流中断：SSE 连接超时", fatal: false, runId: "r2" }} onApproval={async () => undefined} /> },
  { title: "已解决的审批", node: <ProjectionItem approvals={[{ ...approvals[0]!, status: "granted" }]} cwd={null} item={{ kind: "approval", requestId: "ap1", title: "允许写入文件", runId: "r1" }} onApproval={async () => undefined} /> },
];



export function DesignPreview() {
  const [theme, setTheme] = useState<Theme>("paper");
  const [density] = useState<Density>("compact");
  const [reading] = useState(false);
  const [area, setArea] = useState<PanelArea>("agents");
  const [activeAgent, setActiveAgent] = useState("codex");
  const [activeSession, setActiveSession] = useState("s1");
  const [panelOpen, setPanelOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [permissionMode, setPermissionMode] = useState("");
  const [flowId, setFlowId] = useState("");
  const [configOverrides, setConfigOverrides] = useState<Record<string, string | boolean>>({});
  const noop = () => undefined;
  const noopAsync = async () => undefined;

  const agent = agents.find((candidate) => candidate.agent_id === activeAgent) ?? null;
  const session = sessions.find((candidate) => candidate.session_id === activeSession) ?? null;
  const agentSessions = sessions.filter((candidate) => candidate.agent_id === activeAgent);

  return <div className={cn("grid h-[100dvh] min-h-[100dvh] overflow-hidden font-sans text-sm tracking-[-0.01em]", panelOpen && (area === "agents" || area === "flows") ? "grid-cols-[60px_286px_minmax(0,1fr)]" : "grid-cols-[60px_minmax(0,1fr)]", "bg-canvas text-ink")} data-density={density} data-reading={reading ? "serif" : "sans"} data-theme={theme}>
    <AgentRail
      agents={agents}
      area={area}
      selectedAgentId={activeAgent}
      theme={theme}
      onAgent={(id) => { setActiveAgent(id); setArea("agents"); }}
      onArea={setArea}
      onTheme={() => setTheme((current) => current === "paper" ? "carbon" : "paper")}
    />
    {panelOpen && (area === "agents" || area === "flows") && <SessionPanel
      agent={agent}
      activeSessionCount={agentSessions.length}
      archivedSessionCount={0}
      area={area}
      flows={flows}
      flowId={flowId}
      loading={false}
      query=""
      sessions={area === "agents" ? agentSessions : []}
      selectedSessionId={activeSession}
      showArchived={false}
      onCreate={noop}
      onDeleteSession={noopAsync}
      onFlow={setFlowId}
      onQuery={noop}
      onRefresh={noop}
      onSession={(value) => setActiveSession(value.session_id)}
      onToggleArchived={noop}
      onUpdateSession={noopAsync}
    />}
    <main className={cn("relative flex min-h-0 min-w-0 flex-col overflow-hidden", "bg-canvas text-ink")}>
      {(area === "agents" || area === "flows") && <SessionHeader
        agent={agent}
        menuOpen={false}
        menuView={"actions" as MenuView}
        panelOpen={panelOpen}
        renameDraft=""
        session={session}
        runState="running"
        onDelete={noop}
        onMenu={noop}
        onMenuView={noop}
        onRenameDraft={noop}
        onTogglePanel={() => setPanelOpen((current) => !current)}
        onUpdate={noop}
      />}
      {area === "skills" ? <SkillControlPlanePage onNotify={noop} /> : <section aria-label="预览对话" className="min-h-0 flex-1 overflow-y-auto px-8 pt-7">
        {new URLSearchParams(window.location.search).get("state") === "states" ? (
          <div className="mx-auto grid w-full max-w-[880px] gap-8 pb-7">
            {stateShowcase.map((block) => <div key={block.title}><p className={cn("mb-2 text-xs font-semibold uppercase tracking-[0.1em]", "text-faint")}>{block.title}</p>{block.node}</div>)}
          </div>
        ) : (
          <div className="mx-auto grid w-full max-w-[880px] gap-6 pb-7">
            {projections.map((item, index) => <ProjectionItem approvals={approvals} cwd={session?.cwd ?? null} item={item} key={index} onApproval={noopAsync} />)}
          </div>
        )}
      </section>}
      {area !== "skills" && <footer className="px-8 pb-5 pt-3">
        <div className="mx-auto w-full max-w-[880px]">
          <Composer
            attachments={[]}
            commandOpen={false}
            commands={commands}
            configOverrides={configOverrides}
            contextOpen={false}
            disabled={false}
            draft={draft}
            effort={effort}
            flowId={flowId}
            flows={flows}
            model={model}
            modelOption={modelOption}
            permissionMode={permissionMode}
            permissionOption={permissionOption}
            running={false}
            sending={false}
            session={session}
            speedOption={speedOption}
            thoughtLevelOption={thoughtLevelOption}
            workspaceListing={null}
            workspaceLoading={false}
            onAddFiles={noopAsync}
            onCommandOpen={noop}
            onConfigOverride={(option, value) => setConfigOverrides((current) => ({ ...current, [option.id]: value }))}
            onContext={noop}
            onContextNavigate={noop}
            onContextOpen={noop}
            onDraft={setDraft}
            onEffort={setEffort}
            onFiles={noop}
            onFlow={setFlowId}
            onModel={setModel}
            onPermissionMode={setPermissionMode}
            onPickDirectory={noop}
            onRemoveAttachment={noop}
            onStop={noop}
            onSubmit={() => setDraft("")}
          />
        </div>
      </footer>}
    </main>
    {paletteOpen && <CommandPalette agents={agents} canCreate onClose={() => setPaletteOpen(false)} onCreateSession={noop} onSelectAgent={setActiveAgent} onSelectSession={(value) => setActiveSession(value.session_id)} onToggleTheme={() => setTheme((current) => current === "paper" ? "carbon" : "paper")} sessions={agentSessions} />}
  </div>;
}
