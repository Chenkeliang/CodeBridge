// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillCatalogSnapshot } from "@/lib/types";

const apiMock = vi.hoisted(() => ({
  skills: vi.fn(),
  pickSkillSource: vi.fn(),
  previewSkillAssignment: vi.fn(),
  applySkillAssignment: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));

import { SkillControlPlanePage } from "./skill-control-plane";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot: SkillCatalogSnapshot = {
  skills: [
    {
      id: "skill-db",
      name: "database-query",
      description: "Query approved databases",
      source_path: "/Users/test/.agents/skills/database-query",
      source_kind: "shared",
      revision: "a".repeat(64),
      tags: ["database", "readonly"],
      updated_at: "2026-08-24T00:00:00.000Z",
      targets: [
        { agent_id: "codex", target_path: "/Users/test/.codex/skills/database-query", state: "absent", detail: null },
        { agent_id: "claude", target_path: "/Users/test/.claude/skills/database-query", state: "linked", detail: "目标目录可见且 SKILL.md 可读" },
        { agent_id: "cursor", target_path: "/Users/test/.cursor/skills/database-query", state: "conflict", detail: "Target 已存在" },
        { agent_id: "opencode", target_path: "/Users/test/.config/opencode/skills/database-query", state: "absent", detail: null },
        { agent_id: "pi", target_path: "/Users/test/.pi/agent/skills/database-query", state: "absent", detail: null },
      ],
    },
    {
      id: "skill-ui",
      name: "frontend-design",
      description: "Build production interfaces",
      source_path: "/workspace/skills/frontend-design",
      source_kind: "adopted",
      revision: "b".repeat(64),
      tags: ["frontend"],
      updated_at: "2026-08-23T00:00:00.000Z",
      targets: [
        { agent_id: "codex", target_path: "/Users/test/.codex/skills/frontend-design", state: "linked", detail: null },
        { agent_id: "claude", target_path: "/Users/test/.claude/skills/frontend-design", state: "absent", detail: null },
        { agent_id: "cursor", target_path: "/Users/test/.cursor/skills/frontend-design", state: "absent", detail: null },
        { agent_id: "opencode", target_path: "/Users/test/.config/opencode/skills/frontend-design", state: "absent", detail: null },
        { agent_id: "pi", target_path: "/Users/test/.pi/agent/skills/frontend-design", state: "absent", detail: null },
      ],
    },
  ],
  targets: [
    { agent_id: "codex", display_name: "Codex", root_path: "/Users/test/.codex/skills" },
    { agent_id: "claude", display_name: "Claude Code", root_path: "/Users/test/.claude/skills" },
    { agent_id: "cursor", display_name: "Cursor", root_path: "/Users/test/.cursor/skills" },
    { agent_id: "opencode", display_name: "OpenCode", root_path: "/Users/test/.config/opencode/skills" },
    { agent_id: "pi", display_name: "Pi", root_path: "/Users/test/.pi/agent/skills" },
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
    skill_id: "skill-db",
    skill_name: "database-query",
    agent_id: "codex",
    enabled: true,
    source_path: "/Users/test/.agents/skills/database-query",
    target_path: "/Users/test/.codex/skills/database-query",
    current_state: "absent",
    action: "create_link",
    detail: null,
    can_apply: true,
  });
  apiMock.applySkillAssignment.mockResolvedValue({ action: "create_link", state: "linked" });
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
    const toggle = view.host.querySelector('button[aria-label="分发 database-query 到 Codex"]') as HTMLButtonElement;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiMock.previewSkillAssignment).toHaveBeenCalledWith({
      skill_id: "skill-db",
      agent_id: "codex",
      enabled: true,
    });
    expect(view.host.textContent).toContain("/Users/test/.agents/skills/database-query");
    expect(view.host.textContent).toContain("/Users/test/.codex/skills/database-query");
    await act(async () => {
      click(view.host, "确认分发");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.applySkillAssignment).toHaveBeenCalledOnce();
    expect(apiMock.skills).toHaveBeenCalledTimes(2);
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
    click(view.host, "软链对账");
    expect(view.host.textContent).toContain("Target 已存在");
    expect(view.host.textContent).toContain("/Users/test/.cursor/skills/database-query");
    act(() => view.root.unmount());
    view.host.remove();
  });
});
