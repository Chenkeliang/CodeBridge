// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { FlowBatchDraft, FlowBatchSnapshot } from "@/lib/types";
import { FlowBatchPanel } from "./flow-batch-panel.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const draft: FlowBatchDraft = {
  schema_version: 1,
  draft_id: "draft_1",
  session_id: "session_1",
  source_run_id: "run_source",
  flow_id: "flow_orders",
  definition_revision: "sha256:def",
  status: "needs_input",
  revision: 1,
  global_inputs: {},
  items: [
    { item_id: "one", ordinal: 0, label: "订单一", inputs: { oid: "1" }, evidence: {}, issues: [] },
    { item_id: "two", ordinal: 1, label: "订单二", inputs: {}, evidence: {}, issues: [{ code: "missing", field: "oid", message: "缺少 oid", blocking: true }] },
  ],
  source_refs: ["event:1"],
  created_at: "2026-08-24T00:00:00.000Z",
  updated_at: "2026-08-24T00:00:00.000Z",
};

const batch: FlowBatchSnapshot = {
  batch_id: "batch_1",
  draft_id: "draft_1",
  session_id: "session_1",
  flow_id: "flow_orders",
  definition_revision: "sha256:def",
  plan_ir_hash: "sha256:plan",
  concurrency: 3,
  failure_policy: "continue",
  cancel_requested_at: null,
  status: "partial_succeeded",
  counts: { total: 2, queued: 0, running: 0, waiting: 0, succeeded: 1, failed: 1, cancelled: 0, interrupted: 0 },
  items: [
    { item_id: "one", ordinal: 0, attempt: 1, run_id: "run_1", input_hash: "a", inputs: { oid: "1" }, status: "succeeded", terminal_reason: null, supersedes_run_id: null },
    { item_id: "two", ordinal: 1, attempt: 1, run_id: "run_2", input_hash: "b", inputs: { oid: "2" }, status: "failed", terminal_reason: "not found", supersedes_run_id: null },
  ],
  created_at: "2026-08-24T00:00:00.000Z",
  updated_at: "2026-08-24T00:01:00.000Z",
};

describe("FlowBatchPanel", () => {
  it("shows blocking rows and disables confirmation", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<FlowBatchPanel draft={draft} onConfirm={vi.fn()} />));
    expect(host.textContent).toContain("1 项需要补充");
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="确认并执行 2 项"]');
    expect(button?.disabled).toBe(true);
    act(() => root.unmount());
    host.remove();
  });

  it("offers failed-only retry without rerunning succeeded items", () => {
    const retry = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<FlowBatchPanel batch={batch} onRetryFailed={retry} />));
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="只重试 1 个失败项"]');
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(retry).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    host.remove();
  });
});
