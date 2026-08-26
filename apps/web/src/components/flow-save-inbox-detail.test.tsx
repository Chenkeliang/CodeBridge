// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { FlowSaveInboxDetail } from "./flow-save-inbox-detail";
import type { FlowSaveInboxRequest } from "@/lib/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const request: FlowSaveInboxRequest = {
  request_id: "fsr_one",
  session_id: "sess_source",
  agent_id: "pi",
  session_title: "权益复盘",
  request_turn_id: "turn_request",
  request_run_id: "run_request",
  source_turn_id: "turn_source",
  source_run_id: "run_source",
  source_title: "查询权益历史并核对差异",
  source: "agent_intent",
  user_message: "以后都按这个流程查",
  intent_summary: "沉淀可复用的权益核对步骤",
  name_hint: "权益核对",
  source_imported: true,
  created_at: "2026-08-26T04:00:00.000Z",
  event_sequence: 42,
};

describe("FlowSaveInboxDetail", () => {
  it("shows source and user request separately with provenance and source link", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const onOpenSourceSession = vi.fn();
    act(() => root.render(<FlowSaveInboxDetail
      actionState={null}
      agentName="Pi"
      onOpenSourceSession={onOpenSourceSession}
      request={request}
    />));

    expect(host.textContent).toContain("权益核对");
    expect(host.textContent).toContain("Agent · Pi");
    expect(host.textContent).toContain("Session · 权益复盘");
    expect(host.textContent).toContain("来源：查询权益历史并核对差异");
    expect(host.textContent).toContain("你的请求：以后都按这个流程查");
    expect(host.textContent).toContain("沉淀可复用的权益核对步骤");
    expect(host.textContent).toContain("来源为导入历史");
    const sourceLink = host.querySelector('button[aria-label="定位来源 Session"]');
    expect(sourceLink).not.toBeNull();
    act(() => sourceLink!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onOpenSourceSession).toHaveBeenCalledWith(request.session_id);

    act(() => root.unmount());
    host.remove();
  });

  it("falls back to source title and raw Agent id", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<FlowSaveInboxDetail
      actionState={null}
      agentName="unknown-agent"
      request={{ ...request, name_hint: null, agent_id: "unknown-agent" }}
    />));

    expect(host.querySelector("h2")?.textContent).toBe(request.source_title);
    expect(host.textContent).toContain("Agent · unknown-agent");

    act(() => root.unmount());
    host.remove();
  });

  it("renders only the action permitted by busy and retry states", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();

    act(() => root.render(<FlowSaveInboxDetail
      actionState={null}
      agentName="Pi"
      onConfirm={onConfirm}
      onDismiss={onDismiss}
      request={request}
    />));
    const initialButtons = Array.from(host.querySelectorAll("button"));
    act(() => initialButtons.find((button) => button.textContent?.includes("生成 Candidate"))!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => initialButtons.find((button) => button.textContent === "忽略")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onConfirm).toHaveBeenCalledWith(request.request_id);
    expect(onDismiss).toHaveBeenCalledWith(request.request_id);

    act(() => root.render(<FlowSaveInboxDetail
      actionState={{ phase: null, error: "结果未知", retry: "confirm" }}
      agentName="Pi"
      onConfirm={onConfirm}
      onDismiss={onDismiss}
      request={request}
    />));
    expect(host.textContent).toContain("重试生成");
    expect(host.textContent).not.toContain("忽略");

    act(() => root.render(<FlowSaveInboxDetail
      actionState={{ phase: "dismiss", error: null, retry: null }}
      agentName="Pi"
      onConfirm={onConfirm}
      onDismiss={onDismiss}
      request={request}
    />));
    expect(host.textContent).toContain("正在忽略");
    expect(host.querySelectorAll("button:disabled").length).toBeGreaterThan(0);

    act(() => root.unmount());
    host.remove();
  });
});
