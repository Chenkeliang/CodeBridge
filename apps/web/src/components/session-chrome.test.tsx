// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AgentRail, SessionHeader, SessionPanel } from "./session-chrome";
import type { AgentProfile, AgentSession, FlowSaveInboxRequest } from "@/lib/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent: AgentProfile = {
  agent_id: "pi",
  display_name: "Pi",
  adapter: "sdk",
  status: "healthy",
  capabilities: [],
  models: [],
  session_features: [],
};

const session: AgentSession = {
  session_id: "session-1",
  agent_id: "pi",
  provider_session_id: null,
  task_record_id: null,
  flow_id: null,
  flow_definition_revision: null,
  model: null,
  effort: null,
  permission_mode: null,
  cwd: "/workspace",
  additional_directories: [],
  title: "什么是离散数据",
  status: "active",
  pinned_at: null,
  archived_at: null,
  created_at: "2026-08-18T00:00:00.000Z",
  updated_at: "2026-08-18T00:00:00.000Z",
};

function pendingRequest(
  requestId: string,
  overrides: Partial<FlowSaveInboxRequest> = {},
): FlowSaveInboxRequest {
  return {
    request_id: requestId,
    session_id: "session-1",
    agent_id: "pi",
    session_title: "历史 Session",
    request_turn_id: `turn_request_${requestId}`,
    request_run_id: `run_request_${requestId}`,
    source_turn_id: `turn_source_${requestId}`,
    source_run_id: `run_source_${requestId}`,
    source_title: `来源 ${requestId}`,
    source: "agent_intent",
    user_message: "保存刚才的流程",
    intent_summary: null,
    name_hint: null,
    source_imported: false,
    created_at: "2026-08-26T04:00:00.000Z",
    event_sequence: 42,
    ...overrides,
  };
}

function panelProps(): ComponentProps<typeof SessionPanel> {
  return {
    agent,
    activeSessionCount: 1,
    area: "agents",
    archivedSessionCount: 0,
    flows: [],
    flowId: "",
    loading: false,
    query: "",
    sessions: [session],
    selectedSessionId: session.session_id,
    showArchived: false,
    onCreate: vi.fn(),
    onFlow: vi.fn(),
    onQuery: vi.fn(),
    onRefresh: vi.fn(),
    onSession: vi.fn(),
    onUpdateSession: vi.fn(async () => undefined),
    onDeleteSession: vi.fn(async () => undefined),
    onToggleArchived: vi.fn(),
  };
}

describe("SessionPanel menus", () => {
  it("keeps a hostile Session title inside the variable header region", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionHeader
      agent={agent}
      menuOpen={false}
      menuView="actions"
      onDelete={vi.fn()}
      onMenu={vi.fn()}
      onMenuView={vi.fn()}
      onRenameDraft={vi.fn()}
      onTogglePanel={vi.fn()}
      onUpdate={vi.fn()}
      panelOpen
      renameDraft=""
      runState="running"
      session={{ ...session, title: "x".repeat(10_000) }}
    />));

    const header = host.querySelector("header");
    const variable = header?.firstElementChild;
    const actions = header?.lastElementChild;
    expect(variable?.className).toContain("min-w-0");
    expect(variable?.className).toContain("flex-1");
    expect(variable?.className).toContain("overflow-hidden");
    expect(variable?.querySelector("div")?.className).toContain("overflow-hidden");
    expect(actions?.className).toContain("shrink-0");
    expect(host.querySelector('[aria-label="Session 操作"]')).not.toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  it("opens Skills as a first-class vertical rail area", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const onArea = vi.fn();
    act(() => root.render(<AgentRail agents={[agent]} area="agents" selectedAgentId="pi" theme="paper" onAgent={vi.fn()} onArea={onArea} onTheme={vi.fn()} />));

    const button = host.querySelector('button[aria-label="Skills"]');
    expect(button).not.toBeNull();
    act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onArea).toHaveBeenCalledWith("skills");

    act(() => root.unmount());
    host.remove();
  });

  it("renders the Flow pending badge for 1, 99, and 100 requests", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const render = (count: number) => act(() => root.render(<AgentRail
      agents={[agent]}
      area="agents"
      onAgent={vi.fn()}
      onArea={vi.fn()}
      onTheme={vi.fn()}
      pendingFlowSaveCount={count}
      selectedAgentId="pi"
      theme="paper"
    />));

    render(0);
    expect(host.querySelector("[data-flow-save-badge]")).toBeNull();
    render(1);
    expect(host.querySelector("[data-flow-save-badge]")?.textContent).toBe("1");
    expect(host.querySelector('button[aria-label="Flows，1 个待生成请求"]')).not.toBeNull();
    render(99);
    expect(host.querySelector("[data-flow-save-badge]")?.textContent).toBe("99");
    render(100);
    expect(host.querySelector("[data-flow-save-badge]")?.textContent).toBe("99+");

    act(() => root.unmount());
    host.remove();
  });

  it("renders pending requests before Flow groups without selecting a Session", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const onPending = vi.fn();
    const onSession = vi.fn();
    const requests = [
      pendingRequest("known", { name_hint: "仓配复盘" }),
      pendingRequest("unknown", { agent_id: "unknown-agent", source_title: "未知 Agent 来源" }),
    ];
    act(() => root.render(<SessionPanel
      {...panelProps()}
      agents={[agent]}
      area="flows"
      flows={[{
        flow_id: "flow_1",
        name: "已发布流程",
        description: null,
        kind: "runbook",
        status: "published",
        source: "user_defined",
        definition_revision: "rev_1",
        plan_ir_hash: null,
        inputs: [],
        steps: [],
        review_status: null,
        git_revision: null,
        validation_issues: [],
        lineage_root_flow_id: "flow_1",
        parent_flow_id: null,
        provenance: null,
        publication_sequence: 1,
        created_at: "2026-08-26T00:00:00.000Z",
        updated_at: "2026-08-26T00:00:00.000Z",
      }]}
      onPendingFlowSaveRequest={onPending}
      onSession={onSession}
      pendingFlowSaveRequests={requests}
      selectedPendingFlowSaveRequestId={null}
    />));

    expect(host.textContent?.indexOf("待生成 · 2")).toBeLessThan(host.textContent?.indexOf("已发布") ?? -1);
    expect(host.textContent).toContain("仓配复盘");
    expect(host.textContent).toContain("Pi");
    expect(host.textContent).toContain("unknown-agent");
    const pending = host.querySelector('[data-flow-save-inbox-request="known"]');
    expect(pending).not.toBeNull();
    act(() => pending!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onPending).toHaveBeenCalledWith(requests[0]);
    expect(onSession).not.toHaveBeenCalled();

    act(() => root.unmount());
    host.remove();
  });

  it("offers Guide creation only from the Flow management surface", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const onCreateGuide = vi.fn();
    act(() => root.render(<SessionPanel {...panelProps()} area="flows" onCreateGuide={onCreateGuide} />));
    const button = host.querySelector('button[aria-label="新建 Guide 草稿"]');
    expect(button).not.toBeNull();
    act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onCreateGuide).toHaveBeenCalledOnce();
    act(() => root.unmount());
    host.remove();
  });

  it("closes a Session row menu after clicking elsewhere", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionPanel {...panelProps()} />));

    const menuButton = host.querySelector(`button[aria-label="管理 ${session.title}"]`);
    if (!menuButton) throw new Error("Expected Session menu button");
    act(() => menuButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(host.textContent).toContain("PIN Session");

    act(() => document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(host.textContent).not.toContain("PIN Session");

    act(() => root.unmount());
    host.remove();
  });
});
