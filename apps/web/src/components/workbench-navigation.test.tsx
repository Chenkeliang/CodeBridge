// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Workbench } from "./workbench";

vi.mock("@/lib/api", () => ({ api: {
  agents: vi.fn().mockResolvedValue({ agents: [], default_agent_id: null, effective_default_agent_id: null }),
  sessions: vi.fn().mockResolvedValue([]), importSessions: vi.fn().mockResolvedValue({ sessions: [], provider_errors: [] }),
} }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const width = window.innerWidth;
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShow);
  else delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>).showModal;
  localStorage.clear();
});
it("opens the real workbench's mobile session drawer and returns to the workspace on cancel", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Workbench />));
    expect(host.querySelector("dialog")).toBeNull();
    const toggle = host.querySelector('[aria-controls="workbench-session-panel"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(host.querySelector('dialog[open][aria-label="会话列表"]')).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await act(async () => host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(host.querySelector("dialog")).toBeNull(); expect(toggle.getAttribute("aria-expanded")).toBe("false");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
