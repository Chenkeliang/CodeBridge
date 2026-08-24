// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillCatalogSnapshot } from "@/lib/types";

const apiMock = vi.hoisted(() => ({
  skills: vi.fn(),
  pickSkillSource: vi.fn(),
  previewSkillAssignment: vi.fn(),
  previewSkillAdopt: vi.fn(),
  previewSkillGlobalState: vi.fn(),
  previewSkillUnmanage: vi.fn(),
  applySkillPlan: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));

import { SkillControlPlanePage } from "./skill-control-plane";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot: SkillCatalogSnapshot = {
  skills: [
    {
      id: "database-query",
      name: "database-query",
      description: "Query approved databases",
      source_path: "/Users/test/.agents/skills/database-query",
      source_kind: "shared",
      package_revision: "a".repeat(64),
      revision: "a".repeat(64),
      global_state: "enabled",
      ownership: "codebridge_managed",
      can_apply: true,
      tags: ["database", "readonly"],
      updated_at: "2026-08-24T00:00:00.000Z",
      targets: [
        { agent_id: "codex", delivery_mode: "shared_native", target_path: "/Users/test/.agents/skills/database-query", state: "follows_global", mutable: false, detail: null },
        { agent_id: "claude", delivery_mode: "symlink_projection", target_path: "/Users/test/.claude/skills/database-query", state: "linked", mutable: true, detail: "目标目录可见且 SKILL.md 可读" },
        { agent_id: "cursor", delivery_mode: "shared_native", target_path: "/Users/test/.agents/skills/database-query", state: "follows_global", mutable: false, detail: null },
        { agent_id: "opencode", delivery_mode: "shared_native", target_path: "/Users/test/.agents/skills/database-query", state: "follows_global", mutable: false, detail: null },
        { agent_id: "pi", delivery_mode: "shared_native", target_path: "/Users/test/.agents/skills/database-query", state: "follows_global", mutable: false, detail: null },
      ],
    },
    {
      id: "frontend-design",
      name: "frontend-design",
      description: "Build production interfaces",
      source_path: "/workspace/skills/frontend-design",
      source_kind: "adopted",
      package_revision: "b".repeat(64),
      revision: "b".repeat(64),
      global_state: "external",
      ownership: "external_observed",
      can_apply: true,
      tags: ["frontend"],
      updated_at: "2026-08-23T00:00:00.000Z",
      targets: [
        { agent_id: "codex", delivery_mode: "shared_native", target_path: "/Users/test/.agents/skills/frontend-design", state: "follows_global", mutable: false, detail: null },
        { agent_id: "claude", delivery_mode: "symlink_projection", target_path: "/Users/test/.claude/skills/frontend-design", state: "absent", mutable: true, detail: null },
        { agent_id: "cursor", delivery_mode: "shared_native", target_path: "/Users/test/.agents/skills/frontend-design", state: "follows_global", mutable: false, detail: null },
        { agent_id: "opencode", delivery_mode: "shared_native", target_path: "/Users/test/.agents/skills/frontend-design", state: "follows_global", mutable: false, detail: null },
        { agent_id: "pi", delivery_mode: "shared_native", target_path: "/Users/test/.agents/skills/frontend-design", state: "follows_global", mutable: false, detail: null },
      ],
    },
  ],
  targets: [
    { agent_id: "codex", display_name: "Codex", root_path: "/Users/test/.agents/skills", delivery_mode: "shared_native" },
    { agent_id: "claude", display_name: "Claude Code", root_path: "/Users/test/.claude/skills", delivery_mode: "symlink_projection" },
    { agent_id: "cursor", display_name: "Cursor", root_path: "/Users/test/.agents/skills", delivery_mode: "shared_native" },
    { agent_id: "opencode", display_name: "OpenCode", root_path: "/Users/test/.agents/skills", delivery_mode: "shared_native" },
    { agent_id: "pi", display_name: "Pi", root_path: "/Users/test/.agents/skills", delivery_mode: "shared_native" },
  ],
  summary: { total: 2, sources: 2, linked: 2, issues: 1 },
  scanned_at: "2026-08-24T00:00:00.000Z",
};

async function renderPage() {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => {
    root.render(<SkillControlPlanePage onNotify={() => {}} />);
    await Promise.resolve();
  });
  return { host, root };
}

function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  return button as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.skills.mockResolvedValue(snapshot);
  apiMock.pickSkillSource.mockResolvedValue(snapshot);
  apiMock.previewSkillAssignment.mockResolvedValue({
    plan_id: "plan-1",
    kind: "assignment",
    skill_id: "database-query",
    package_revision: "a".repeat(64),
    source_path: "/Users/test/.agents/skills/database-query",
    target_path: "/Users/test/.claude/skills/database-query",
    expires_at: "2026-08-24T01:00:00.000Z",
    request: { agent_id: "claude", enabled: false },
    steps: [{ action: "remove_link", detail: "移除 Claude 软链" }],
    detail: null,
    can_apply: true,
  });
  apiMock.previewSkillAdopt.mockResolvedValue({
    plan_id: "plan-adopt", kind: "adopt", skill_id: "frontend-design",
    package_revision: "b".repeat(64), source_path: "/workspace/skills/frontend-design",
    target_path: "/Users/test/.agents/skills/frontend-design", expires_at: "2026-08-24T01:00:00.000Z",
    request: {}, steps: [{ action: "move", detail: "移动到共享目录" }], detail: null, can_apply: true,
  });
  apiMock.previewSkillGlobalState.mockResolvedValue({
    plan_id: "plan-global", kind: "global_state", skill_id: "database-query",
    package_revision: "a".repeat(64), source_path: "/Users/test/.agents/skills/database-query",
    target_path: "/Users/test/.agents/skills-disabled/database-query", expires_at: "2026-08-24T01:00:00.000Z",
    request: { enabled: false }, steps: [{ action: "move", detail: "移入停用目录" }], detail: null, can_apply: true,
  });
  apiMock.applySkillPlan.mockResolvedValue({ plan_id: "plan-1", transaction_id: "tx-1", snapshot });
});

describe("SkillControlPlanePage", () => {
  it("loads the real catalog and filters without inventing records", async () => {
    const view = await renderPage();
    expect(view.host.textContent).toContain("database-query");
    expect(view.host.textContent).toContain("frontend-design");
    const input = view.host.querySelector('input[aria-label="搜索 Skill"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "database");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(view.host.textContent).toContain("database-query");
    expect(view.host.textContent).not.toContain("frontend-design");
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("previews before applying an Agent distribution and refreshes observed state", async () => {
    const view = await renderPage();
    click(view.host, "Agent 分发");
    expect(view.host.textContent).toContain("跟随全局");
    const toggle = view.host.querySelector('button[aria-label="移除 database-query 从 Claude Code"]') as HTMLButtonElement;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiMock.previewSkillAssignment).toHaveBeenCalledWith({
      skill_id: "database-query",
      agent_id: "claude",
      enabled: false,
    });
    expect(view.host.textContent).toContain("/Users/test/.agents/skills/database-query");
    expect(view.host.textContent).toContain("/Users/test/.claude/skills/database-query");
    await act(async () => {
      click(view.host, "确认应用");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.applySkillPlan).toHaveBeenCalledWith("assignment", "plan-1");
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("adopts a picked local Source and exposes reconciliation states", async () => {
    const view = await renderPage();
    await act(async () => {
      click(view.host, "添加 Skill");
      await Promise.resolve();
    });
    expect(apiMock.pickSkillSource).toHaveBeenCalledOnce();
    click(view.host, "frontend-design");
    await act(async () => {
      click(view.host, "纳管 Skill");
      await Promise.resolve();
    });
    expect(apiMock.previewSkillAdopt).toHaveBeenCalledWith("frontend-design");
    expect(view.host.textContent).toContain("移动到共享目录");
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("previews global disable from the managed Skill drawer", async () => {
    const view = await renderPage();
    click(view.host, "database-query");
    await act(async () => {
      click(view.host, "全局停用");
      await Promise.resolve();
    });
    expect(apiMock.previewSkillGlobalState).toHaveBeenCalledWith("database-query", false);
    expect(view.host.textContent).toContain("移入停用目录");
    act(() => view.root.unmount());
    view.host.remove();
  });
});
