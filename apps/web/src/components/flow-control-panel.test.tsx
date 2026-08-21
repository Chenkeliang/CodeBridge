// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { FlowCapability, FlowRecord, FlowReviewContext } from "@/lib/types";
import { FlowControlPanel } from "./flow-control-panel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const candidate: FlowRecord = {
  flow_id: "flow_candidate",
  name: "Candidate",
  description: "Derived from a successful run",
  kind: "runbook",
  status: "candidate",
  source: "user_selected",
  definition_revision: "sha256:candidate",
  plan_ir_hash: "sha256:plan",
  inputs: [{ id: "text", type: "string", source: "user", required: true }],
  steps: [{
    id: "echo", capability: "demo.echo", purpose: "Echo text", depends_on: [], mode: "read_only",
    approval: "none", branches: [], retry: null, success_when: "output.text exists",
  }],
  review_status: "pending",
  git_revision: null,
  validation_issues: [],
  lineage_root_flow_id: "flow_source",
  parent_flow_id: "flow_source",
  provenance: {
    source_run_id: "run_source",
    source_session_id: "sess_source",
    source_flow_id: "flow_source",
    source_definition_revision: "sha256:source",
  },
  publication_sequence: 0,
  created_at: "2026-08-21T00:00:00.000Z",
  updated_at: "2026-08-21T00:00:00.000Z",
};

const capabilities: FlowCapability[] = [{
  id: "demo.echo", adapter: "demo.echo", risk: "read_only", description: "Echo input", side_effects: false,
}];

function context(withEvidence = true): FlowReviewContext {
  return {
    flow: candidate,
    base: { ...candidate, flow_id: "flow_source", name: "Source", status: "published", definition_revision: "sha256:source", publication_sequence: 1 },
    diff: {
      name_changed: true,
      description_changed: false,
      inputs: { added: [], removed: [], changed: [] },
      steps: { added: [], removed: [], changed: ["echo"], reordered: false },
    },
    provenance: candidate.provenance,
    evidence: withEvidence ? [{
      run_id: "run_dry", session_id: "sess_source", status: "succeeded", definition_revision: candidate.definition_revision,
      plan_ir_hash: candidate.plan_ir_hash!, created_at: "2026-08-21T00:01:00.000Z", updated_at: "2026-08-21T00:02:00.000Z",
    }] : [],
    history: [{
      id: 1, flow_id: candidate.flow_id, definition_revision: candidate.definition_revision,
      action: "created", snapshot: candidate, created_at: candidate.created_at,
    }],
  };
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof FlowControlPanel>> = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const props: React.ComponentProps<typeof FlowControlPanel> = {
    context: context(),
    capabilities,
    busy: false,
    error: null,
    onSave: () => {},
    onReview: () => {},
    onDeprecate: () => {},
    ...overrides,
  };
  act(() => root.render(<FlowControlPanel {...props} />));
  return { host, root };
}

function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  return button as HTMLButtonElement;
}

describe("FlowControlPanel", () => {
  it("edits Guide drafts without exposing executable fields", () => {
    const onSave = vi.fn();
    const guide: FlowRecord = {
      ...candidate,
      flow_id: "flow_guide",
      kind: "guide",
      status: "draft",
      inputs: [],
      steps: [{ ...candidate.steps[0]!, capability: null, mode: "manual", success_when: null }],
    };
    const view = renderPanel({
      context: { ...context(false), flow: guide, base: null, provenance: null, evidence: [] },
      onSave,
    });
    expect(view.host.textContent).toContain("Guide 仅用于整理草稿");
    expect(view.host.querySelector('select[aria-label="步骤 1 Capability"]')).toBeNull();
    const name = view.host.querySelector('input[aria-label="Flow 名称"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(name, "Guide v2");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(view.host, "保存 Guide 草稿");
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      flow_id: "flow_guide",
      name: "Guide v2",
      kind: "guide",
      status: "draft",
    }));
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("promotes a Guide into a new Candidate editing draft", () => {
    const onSave = vi.fn();
    const guide: FlowRecord = {
      ...candidate, flow_id: "flow_guide", kind: "guide", status: "draft", inputs: [],
      steps: [{ ...candidate.steps[0]!, capability: null, mode: "manual", success_when: null }],
    };
    const view = renderPanel({ context: { ...context(false), flow: guide, base: null, provenance: null, evidence: [] }, onSave });
    click(view.host, "升级为 Candidate");
    expect(view.host.textContent).toContain("保存 Candidate");
    expect(view.host.querySelector('select[aria-label="步骤 1 Capability"]')).not.toBeNull();
    click(view.host, "保存 Candidate");
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      flow_id: "", parent_flow_id: "flow_guide", kind: "runbook", status: "candidate",
    }));
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("renders semantic review evidence, provenance, history, and capability mapping", () => {
    const view = renderPanel();
    expect(view.host.textContent).toContain("run_source");
    expect(view.host.textContent).toContain("run_dry");
    expect(view.host.textContent).toContain("demo.echo");
    expect(view.host.textContent).toContain("read_only");
    expect(view.host.textContent).toContain("created");
    expect(view.host.textContent).toContain("echo");
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("emits the complete structured Candidate after edits", () => {
    const onSave = vi.fn();
    const view = renderPanel({ onSave });
    const name = view.host.querySelector('input[aria-label="Flow 名称"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(name, "Candidate v2");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(view.host, "保存 Candidate");
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      flow_id: candidate.flow_id,
      name: "Candidate v2",
      inputs: candidate.inputs,
      steps: candidate.steps,
    }));
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("requires exact evidence and a git revision before approval", () => {
    const onReview = vi.fn();
    const view = renderPanel({ context: context(false), onReview });
    const approve = click(view.host, "批准并发布");
    expect(approve.disabled).toBe(true);
    expect(onReview).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain("先完成当前 revision 的 Dry-run");
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("approves with git audit metadata and always permits rejection", () => {
    const onReview = vi.fn();
    const view = renderPanel({ onReview });
    const git = view.host.querySelector('input[aria-label="Git revision"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(git, "git-abc");
      git.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(view.host, "批准并发布");
    click(view.host, "打回");
    expect(onReview).toHaveBeenNthCalledWith(1, "approve", "git-abc");
    expect(onReview).toHaveBeenNthCalledWith(2, "reject");
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("offers explicit deprecation only for Published Runbooks", () => {
    const onDeprecate = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const published = { ...context(), flow: { ...candidate, status: "published" as const, publication_sequence: 2 } };
    const view = renderPanel({ context: published, onDeprecate });
    click(view.host, "废弃 Flow");
    expect(onDeprecate).toHaveBeenCalledOnce();
    act(() => view.root.unmount());
    view.host.remove();
    vi.restoreAllMocks();
  });
});
