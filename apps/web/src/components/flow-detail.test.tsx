// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { FlowRecord } from "@/lib/types";
import { FlowDetail } from "./flow-detail";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const echoFlow: FlowRecord = {
  flow_id: "flow_demo_echo", name: "Demo Echo", kind: "runbook", status: "published",
  source: "user_selected", definition_revision: "sha256:def", plan_ir_hash: "sha256:abcdef0123456789",
  review_status: "approved", validation_issues: [],
  inputs: [{ id: "text", type: "string", source: "user", required: true }],
  steps: [
    { id: "echo", capability: "demo.echo", purpose: null, depends_on: [], mode: "read_only", approval: "none", branches: [], retry: null, success_when: "output.text exists" },
    { id: "concat", capability: "demo.concat", purpose: null, depends_on: ["echo"], mode: "read_only", approval: "none", branches: [], retry: null, success_when: "output.result exists" },
  ],
};

function renderDetail(props: ComponentProps<typeof FlowDetail>) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(<FlowDetail {...props} />));
  const input = (label: string) => host.querySelector(`input[aria-label="${label}"]`);
  return { host, root, input };
}

function clickButton(host: HTMLElement, label: string | RegExp) {
  const button = [...host.querySelectorAll("button")].find((node) =>
    typeof label === "string" ? node.textContent?.includes(label) : label.test(node.textContent ?? ""),
  );
  if (!button) throw new Error(`button not found: ${label}`);
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("FlowDetail", () => {
  it("renders inputs, steps, and revision tail", () => {
    const view = renderDetail({ flow: echoFlow, values: {}, missing: [], onValues: () => {}, onSubmit: () => {}, onClose: () => {} });
    expect(view.input("text")).toBeTruthy();
    expect(view.host.textContent).toContain("demo.echo");
    expect(view.host.textContent).toContain("output.text exists");
    expect(view.host.textContent).toContain("23456789");
  });

  it("shows a parent-provided value", () => {
    const view = renderDetail({ flow: echoFlow, values: { text: "hi" }, missing: [], onValues: () => {}, onSubmit: () => {}, onClose: () => {} });
    expect((view.input("text") as HTMLInputElement).value).toBe("hi");
  });

  it("submits with structured inputs and dryRun false", () => {
    const onSubmit = vi.fn();
    const view = renderDetail({ flow: echoFlow, values: { text: "hello" }, missing: [], onValues: () => {}, onSubmit, onClose: () => {} });
    clickButton(view.host, /运行/);
    expect(onSubmit).toHaveBeenCalledWith({ text: "hello" }, false);
  });

  it("binds a Published Runbook only through the explicit action", () => {
    const onBind = vi.fn();
    const view = renderDetail({
      flow: echoFlow,
      values: {},
      missing: [],
      onValues: () => {},
      onSubmit: () => {},
      onBind,
      onClose: () => {},
    });
    clickButton(view.host, /绑定到会话/);
    expect(onBind).toHaveBeenCalledWith(echoFlow);
  });

  it("notifies the parent of edits", () => {
    const onValues = vi.fn();
    const view = renderDetail({ flow: echoFlow, values: {}, missing: [], onValues, onSubmit: () => {}, onClose: () => {} });
    const input = view.input("text") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "typed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onValues).toHaveBeenCalledWith({ text: "typed" });
  });

  it("keeps filled values when missing is applied by the parent", () => {
    const onValues = vi.fn();
    const view = renderDetail({
      flow: echoFlow, values: { text: "kept" }, missing: [{ id: "text", type: "string", source: "user", reason: "required" }],
      onValues, onSubmit: () => {}, onClose: () => {},
    });
    expect((view.input("text") as HTMLInputElement).value).toBe("kept");
    expect(view.host.textContent).toContain("缺少必填参数");
  });

  it("shows a dry-run button for candidate flows", () => {
    const onSubmit = vi.fn();
    const view = renderDetail({ flow: { ...echoFlow, status: "candidate" }, values: {}, missing: [], onValues: () => {}, onSubmit, onClose: () => {} });
    clickButton(view.host, /dry-run|预演/);
    expect(onSubmit).toHaveBeenCalledWith({}, true);
  });

  it("does not offer a live run for candidate flows", () => {
    const onSubmit = vi.fn();
    const view = renderDetail({ flow: { ...echoFlow, status: "candidate" }, values: { text: "hi" }, missing: [], onValues: () => {}, onSubmit, onClose: () => {} });
    const labels = [...view.host.querySelectorAll("button")].map((node) => node.textContent ?? "");
    expect(labels.some((label) => label.includes("运行"))).toBe(false);
    expect(labels.some((label) => /dry-run|预演/i.test(label))).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { ...echoFlow, kind: "guide" as const, status: "draft" as const },
    { ...echoFlow, status: "draft" as const },
    { ...echoFlow, status: "deprecated" as const },
  ])("keeps non-runnable states read-only", (flow) => {
    const view = renderDetail({ flow, values: {}, missing: [], onValues: () => {}, onSubmit: () => {}, onClose: () => {} });
    const labels = [...view.host.querySelectorAll("button")].map((node) => node.textContent ?? "");
    expect(labels.some((label) => label.includes("运行一次"))).toBe(false);
    expect(labels.some((label) => label.includes("绑定到会话"))).toBe(false);
    expect(labels.some((label) => /dry-run|预演/i.test(label))).toBe(false);
  });
});
