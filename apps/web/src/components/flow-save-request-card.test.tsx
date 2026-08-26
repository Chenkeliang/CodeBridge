// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { TimelineBlockView } from "@/lib/types";
import { FlowSaveRequestCard } from "./flow-save-request-card.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function block(
  status: TimelineBlockView["status"],
  metadata: Record<string, unknown> = {},
): TimelineBlockView {
  return {
    block_id: "flow_save:fsr_one",
    block_index: 2,
    kind: "flow_save_request",
    status,
    metadata: {
      request_id: "fsr_one",
      source_run_id: "run_source",
      source_title: "查询公司权益并核对交付",
      user_message: "把刚才存为 Flow",
      intent_summary: "保留这套查询流程",
      source_imported: false,
      ...metadata,
    },
    segments: [],
    next_segment_cursor: null,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof FlowSaveRequestCard>> = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const onConfirm = vi.fn();
  const onDismiss = vi.fn();
  const onOpenCandidate = vi.fn();
  act(() => root.render(<FlowSaveRequestCard
    actionState={null}
    block={block("pending")}
    onConfirm={onConfirm}
    onDismiss={onDismiss}
    onOpenCandidate={onOpenCandidate}
    {...props}
  />));
  return {
    host,
    onConfirm,
    onDismiss,
    onOpenCandidate,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("FlowSaveRequestCard", () => {
  it("renders a pending request and delegates both explicit actions", () => {
    const view = renderCard();
    expect(view.host.textContent).toContain("存为 Flow？");
    expect(view.host.textContent).toContain("查询公司权益并核对交付");
    expect(view.host.textContent).toContain("你的请求：把刚才存为 Flow");
    expect(view.host.textContent).toContain("生成 Candidate");
    expect(view.host.textContent).toContain("预演和审查");

    const buttons = Array.from(view.host.querySelectorAll("button"));
    act(() => buttons.find((button) => button.textContent?.includes("生成 Candidate"))?.click());
    act(() => buttons.find((button) => button.textContent?.includes("忽略"))?.click());
    expect(view.onConfirm).toHaveBeenCalledWith("fsr_one");
    expect(view.onDismiss).toHaveBeenCalledWith("fsr_one");
    view.cleanup();
  });

  it("warns when an explicit request came from imported history", () => {
    const view = renderCard({
      block: block("pending", { source_imported: true }),
    });
    expect(view.host.textContent).toContain("来源为导入历史");
    expect(view.host.textContent).toContain("请确认其步骤仍然适用");
    view.cleanup();
  });

  it("disables actions and shows progress while confirming", () => {
    const view = renderCard({
      actionState: { phase: "confirm", error: null, retry: null },
    });
    expect(view.host.textContent).toContain("正在生成 Candidate");
    expect(Array.from(view.host.querySelectorAll("button")).every((button) => button.disabled)).toBe(true);
    expect(view.host.querySelector(".animate-spin")).not.toBeNull();
    view.cleanup();
  });

  it("disables actions and shows progress while dismissing", () => {
    const view = renderCard({
      actionState: { phase: "dismiss", error: null, retry: null },
    });
    expect(view.host.textContent).toContain("正在忽略");
    expect(Array.from(view.host.querySelectorAll("button")).every((button) => button.disabled)).toBe(true);
    expect(view.host.querySelector(".animate-spin")).not.toBeNull();
    view.cleanup();
  });

  it("renders the persisted completed state and opens the Candidate", () => {
    const view = renderCard({
      block: block("completed", {
        flow_id: "flow_candidate_1234567890",
        definition_revision: "sha256:def",
        name_hint: "公司权益核对",
      }),
    });
    expect(view.host.textContent).toContain("已生成 Candidate");
    expect(view.host.textContent).toContain("公司权益核对");
    act(() => view.host.querySelector<HTMLButtonElement>("button")?.click());
    expect(view.onOpenCandidate).toHaveBeenCalledWith("flow_candidate_1234567890");
    view.cleanup();
  });

  it("renders dismissed and failed requests as immutable terminal evidence", () => {
    const dismissed = renderCard({ block: block("dismissed") });
    expect(dismissed.host.textContent).toContain("已忽略");
    expect(dismissed.host.querySelector("button")).toBeNull();
    dismissed.cleanup();

    const failed = renderCard({
      block: block("failed", { error_code: "source_run_not_extractable" }),
    });
    expect(failed.host.textContent).toContain("source_run_not_extractable");
    expect(failed.host.textContent).toContain("从 Turn 菜单重新选择来源");
    expect(failed.host.querySelector("button")).toBeNull();
    failed.cleanup();
  });

  it("shows a retry only for an unknown local confirm outcome", () => {
    const view = renderCard({
      actionState: {
        phase: null,
        error: "生成结果未知，请使用同一次确认重试。",
        retry: "confirm",
      },
    });
    expect(view.host.textContent).toContain("生成结果未知");
    const retry = Array.from(view.host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("重试生成"));
    expect(retry).toBeDefined();
    expect(Array.from(view.host.querySelectorAll("button"))
      .some((button) => button.textContent?.includes("忽略"))).toBe(false);
    act(() => retry?.click());
    expect(view.onConfirm).toHaveBeenCalledWith("fsr_one");
    view.cleanup();
  });

  it("shows only a same-command dismiss retry after an unknown dismiss outcome", () => {
    const view = renderCard({
      actionState: {
        phase: null,
        error: "忽略结果未知，请再次点击“忽略”安全重试。",
        retry: "dismiss",
      },
    });
    expect(view.host.textContent).toContain("忽略结果未知");
    const retry = Array.from(view.host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("重试忽略"));
    expect(retry).toBeDefined();
    expect(Array.from(view.host.querySelectorAll("button"))
      .some((button) => button.textContent?.includes("生成 Candidate"))).toBe(false);
    act(() => retry?.click());
    expect(view.onDismiss).toHaveBeenCalledWith("fsr_one");
    expect(view.onConfirm).not.toHaveBeenCalled();
    view.cleanup();
  });

  it("contains hostile display fields without viewport-level clipping", () => {
    const view = renderCard({
      block: block("failed", {
        user_message: "https://example.com/" + "long/".repeat(600),
        error_code: "x".repeat(2_048),
      }),
    });
    const card = view.host.querySelector<HTMLElement>("[data-flow-save-request]");
    expect(card?.className).toContain("min-w-0");
    expect(card?.className).toContain("max-w-full");
    expect(card?.innerHTML).toContain("overflow-wrap:anywhere");
    expect(card?.className).not.toContain("overflow-hidden");
    view.cleanup();
  });
});
