// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { SessionQueue } from "./session-queue.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SessionQueue", () => {
  it("uses Turn versions for cancel and the Runtime version for resume", () => {
    const onCancel = vi.fn();
    const onResume = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionQueue
      cancellingTurnId={null}
      loadingMore={false}
      onCancel={onCancel}
      onLoadMore={vi.fn()}
      onResume={onResume}
      runtime={{
        active_run: null,
        queue_state: "paused",
        queue_pause_reason: "failed",
        queue: { turns: [], total: 1, next_cursor: 1 },
        version: 3,
        last_event_sequence: 4,
      }}
      turns={[{
        turn_id: "turn-1",
        queue_position: 7,
        status: "queued",
        version: 2,
        message: { text: "review the queue", attachment_ids: [] },
        created_at: "2026-08-14T00:00:00.000Z",
      }]}
    />));
    expect(host.textContent).toContain("下一轮队列 · 1");
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="取消排队消息 7"]')?.click());
    act(() => [...host.querySelectorAll("button")].find((button) => button.textContent === "继续队列")?.click());
    expect(onCancel).toHaveBeenCalledWith("turn-1", 2);
    expect(onResume).toHaveBeenCalledWith(3);
    expect(host.textContent).toContain("上一轮失败，队列暂停。");
    act(() => root.unmount());
    host.remove();
  });

  it("contains hostile queue text without removing its cancel action", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionQueue
      cancellingTurnId={null}
      loadingMore={false}
      onCancel={vi.fn()}
      onLoadMore={vi.fn()}
      onResume={vi.fn()}
      runtime={{
        active_run: null,
        queue_state: "ready",
        queue_pause_reason: null,
        queue: { turns: [], total: 1, next_cursor: null },
        version: 1,
        last_event_sequence: 1,
      }}
      turns={[{
        turn_id: "turn-hostile",
        queue_position: 1,
        status: "queued",
        version: 1,
        message: { text: "x".repeat(10_000), attachment_ids: [] },
        created_at: "2026-08-25T00:00:00.000Z",
      }]}
    />));

    expect(host.querySelector("section")?.className).toContain("min-w-0");
    expect(host.querySelector("section")?.className).toContain("overflow-hidden");
    expect(host.querySelector("ol")?.className).toContain("min-w-0");
    expect(host.querySelector("li")?.className).toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
    const message = host.querySelector("li span:nth-child(2)");
    expect(message?.className).toContain("line-clamp-2");
    expect(message?.className).toContain("[overflow-wrap:anywhere]");
    expect(host.querySelector('[aria-label="取消排队消息 1"]')).not.toBeNull();

    act(() => root.unmount());
    host.remove();
  });
});
