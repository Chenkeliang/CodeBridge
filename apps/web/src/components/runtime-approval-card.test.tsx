// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { TimelineBlockView } from "@/lib/types";
import { RuntimeApprovalCard } from "./runtime-approval-card.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function block(status = "waiting", approvalId: string | null = "approval_1"): TimelineBlockView {
  return {
    block_id: "approval:approval_1",
    block_index: 0,
    kind: "approval",
    status,
    metadata: {
      ...(approvalId ? { approval_id: approvalId } : {}),
      step_id: "deploy",
      capability_id: "deploy.production",
    },
    segments: [],
    next_segment_cursor: null,
  };
}

describe("RuntimeApprovalCard", () => {
  it("disables actions when approval_id is missing", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<RuntimeApprovalCard
      block={block("waiting", null)}
      busy={false}
      onResolve={vi.fn()}
      runId="run_1"
    />));
    expect(host.textContent).toContain("缺少 approval_id");
    expect(Array.from(host.querySelectorAll("button")).every((button) => button.disabled)).toBe(true);
    act(() => root.unmount());
    host.remove();
  });

  it.each([
    ["granted", "Runtime 步骤已批准"],
    ["rejected", "Runtime 步骤已拒绝"],
    ["expired", "审批已过期"],
  ] as const)("renders the %s terminal state without actions", (status, label) => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<RuntimeApprovalCard
      block={block(status)}
      busy={false}
      runId="run_1"
    />));
    expect(host.textContent).toContain(label);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    act(() => root.unmount());
    host.remove();
  });
});
