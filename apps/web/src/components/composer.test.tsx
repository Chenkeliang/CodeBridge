// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession, ConfigOption, FlowRecord } from "@/lib/types";
import { Composer } from "./composer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};

const session: AgentSession = {
  session_id: "session-1",
  agent_id: "codex",
  provider_session_id: null,
  task_record_id: null,
  flow_id: null,
  model: "gpt-5",
  effort: "medium",
  permission_mode: "ask",
  cwd: "/workspace/app",
  additional_directories: [],
  title: "Session",
  status: "active",
  pinned_at: null,
  archived_at: null,
  created_at: "2026-08-14T00:00:00.000Z",
  updated_at: "2026-08-14T00:00:00.000Z",
};

const modelOption: ConfigOption = {
  id: "model",
  name: "Model",
  type: "select",
  category: "model",
  currentValue: "gpt-5",
  values: [{ value: "gpt-5", name: "GPT-5" }],
};

const thoughtLevelOption: ConfigOption = {
  id: "reasoning",
  name: "Reasoning",
  type: "select",
  category: "thought_level",
  currentValue: "medium",
  values: [
    { value: "low", name: "低" },
    { value: "medium", name: "中" },
    { value: "high", name: "高" },
  ],
};

const speedOption: ConfigOption = {
  id: "fast-mode",
  name: "Fast mode",
  type: "boolean",
  category: "model_config",
  currentValue: "false",
  values: [
    { value: "false", name: "Off" },
    { value: "true", name: "On" },
  ],
};

const permissionOption: ConfigOption = {
  id: "permission",
  name: "Permission",
  type: "select",
  category: "mode",
  currentValue: "ask",
  values: [
    { value: "ask", name: "Ask" },
    { value: "allow", name: "Allow" },
  ],
};

const flow: FlowRecord = {
  flow_id: "flow-1",
  name: "Review Flow",
  kind: "guide",
  status: "published",
  source: "test",
  definition_revision: "1",
};

function composerProps(): ComponentProps<typeof Composer> {
  return {
    attachments: [
      { name: "paste.png", mimeType: "image/png", dataBase64: "aW1hZ2U=" },
      { name: "notes.txt", mimeType: "text/plain", dataBase64: "bm90ZXM=" },
    ],
    commands: [{ name: "status", description: "Display status" }],
    contextOpen: false,
    workspaceListing: {
      ok: true,
      root: "/workspace/app",
      path: "/workspace/app",
      relativePath: "",
      entries: [],
    },
    workspaceLoading: false,
    disabled: false,
    draft: "检查这次修改",
    flowId: "",
    flows: [flow],
    model: "gpt-5",
    modelOption,
    effort: "medium",
    thoughtLevelOption,
    configOverrides: {},
    speedOption,
    permissionMode: "ask",
    permissionOption,
    sending: false,
    session,
    commandOpen: false,
    running: true,
    onAddFiles: vi.fn(async () => undefined),
    onCommandOpen: vi.fn(),
    onContext: vi.fn(),
    onContextNavigate: vi.fn(),
    onContextOpen: vi.fn(),
    onDraft: vi.fn(),
    onFiles: vi.fn(),
    onFlow: vi.fn(),
    onModel: vi.fn(),
    onEffort: vi.fn(),
    onConfigOverride: vi.fn(),
    onPermissionMode: vi.fn(),
    onPickDirectory: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
  };
}

function renderComposer(overrides: Partial<ReturnType<typeof composerProps>> = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const props = { ...composerProps(), ...overrides };
  act(() => root.render(<Composer {...props} />));
  return { host, props, root };
}

function click(element: Element | null) {
  if (!element) throw new Error("Expected clickable element");
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("Composer", () => {
  it("uses the minimal layout while preserving attachments and Run actions", () => {
    const view = renderComposer();
    const attachments = view.host.querySelector("[data-composer-attachments]");

    expect(attachments?.nextElementSibling?.hasAttribute("data-composer-editor")).toBe(true);
    expect(view.host.querySelector('img[alt="paste.png"]')).not.toBeNull();
    expect(view.host.textContent).toContain("notes.txt");
    expect(view.host.querySelector('button[aria-label="Composer actions"]')).not.toBeNull();
    expect(view.host.querySelector('button[aria-label="Permission"]')).not.toBeNull();
    expect(view.host.querySelector('button[aria-label="Model and reasoning"]')).not.toBeNull();
    expect(view.host.querySelector('button[aria-label="停止当前 Run"]')).not.toBeNull();
    expect(view.host.querySelector('button[aria-label="发送"]')?.hasAttribute("disabled")).toBe(false);
    expect(view.host.textContent).not.toContain("Enter 发送");
    expect(view.host.querySelector('[aria-label="Markdown toolbar"]')).toBeNull();
    expect(view.host.querySelector('[aria-label="Preview"]')).toBeNull();
    expect(view.host.querySelector('button[aria-label="Agent commands"]')).toBeNull();
    expect(view.host.querySelector('button[aria-label="插入上下文"]')).toBeNull();

    click(view.host.querySelector('button[aria-label="移除 notes.txt"]'));
    click(view.host.querySelector('button[aria-label="停止当前 Run"]'));
    click(view.host.querySelector('button[aria-label="发送"]'));
    expect(view.props.onRemoveAttachment).toHaveBeenCalledWith(1);
    expect(view.props.onStop).toHaveBeenCalledOnce();
    expect(view.props.onSubmit).toHaveBeenCalledOnce();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("moves files, Workspace, and Flow into plus while grouping model controls", () => {
    const view = renderComposer();

    click(view.host.querySelector('button[aria-label="Composer actions"]'));
    expect(document.body.textContent).toContain("添加文件");
    expect(document.body.textContent).toContain("插入 Workspace 上下文");
    expect(document.body.textContent).toContain("添加 Workspace");
    expect(document.body.querySelector('button[aria-label="Flow"]')).not.toBeNull();
    click([...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("添加文件")) ?? null);
    click([...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("插入 Workspace 上下文")) ?? null);
    click([...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("添加 Workspace")) ?? null);
    expect(view.props.onFiles).toHaveBeenCalledOnce();
    expect(view.props.onContextOpen).toHaveBeenCalledWith(true);
    expect(view.props.onPickDirectory).toHaveBeenCalledOnce();

    click(view.host.querySelector('button[aria-label="Model and reasoning"]'));
    expect(document.body.textContent).toContain("Model");
    expect(document.body.textContent).toContain("推理强度");
    expect(document.body.textContent).toContain("速度");
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("keeps slash and Workspace suggestions available without toolbar buttons", () => {
    const commandView = renderComposer({ commandOpen: true, draft: "/sta" });
    expect(commandView.host.textContent).toContain("/status");
    click([...commandView.host.querySelectorAll("button")].find((button) => button.textContent?.includes("/status")) ?? null);
    expect(commandView.props.onDraft).toHaveBeenCalledWith("/status ");
    act(() => commandView.root.unmount());
    commandView.host.remove();

    const contextView = renderComposer({
      contextOpen: true,
      draft: "@src",
      workspaceListing: {
        ok: true,
        root: "/workspace/app",
        path: "/workspace/app",
        relativePath: "",
        entries: [{
          name: "src",
          path: "src",
          absolutePath: "/workspace/app/src",
          kind: "file",
        }],
      },
    });
    expect(contextView.host.textContent).toContain("/workspace/app/src");
    click([...contextView.host.querySelectorAll("button")].find((button) => button.textContent?.includes("/workspace/app/src")) ?? null);
    expect(contextView.props.onContext).toHaveBeenCalledWith("/workspace/app/src");
    act(() => contextView.root.unmount());
    contextView.host.remove();
  });
});
