// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AgentRail, SessionHeader, SessionPanel } from "./session-chrome";
import type { AgentProfile, AgentSession } from "@/lib/types";

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
