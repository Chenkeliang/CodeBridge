// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderHistoryImportCard,
  providerHistoryErrorPresentation,
  type ProviderHistoryImportState,
} from "./provider-history-import-card.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ host: HTMLDivElement; root: Root }> = [];

afterEach(() => {
  while (mounted.length > 0) {
    const view = mounted.pop();
    if (!view) continue;
    act(() => view.root.unmount());
    view.host.remove();
  }
});

function render(state: ProviderHistoryImportState, actions: {
  onImport?: () => void;
  onRetryPreview?: () => void;
  onRetryImport?: () => void;
} = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  mounted.push({ host, root });
  act(() => root.render(<ProviderHistoryImportCard state={state} {...actions} />));
  return host;
}

const preview = {
  providerSessionId: "provider-session-1",
  importedPosition: 0,
  providerPosition: 401,
  importableEvents: 401,
  nextDigest: "sha256:preview",
};

describe("ProviderHistoryImportCard", () => {
  it("renders previewing, available, importing, imported, and empty states", () => {
    expect(render({ kind: "previewing", sessionId: "sess_1" }).textContent)
      .toContain("正在检查历史");

    const onImport = vi.fn();
    const available = render({ kind: "available", sessionId: "sess_1", preview }, { onImport });
    expect(available.textContent).toContain("发现 401 条可导入历史记录");
    expect(available.querySelectorAll("button")).toHaveLength(1);
    expect(available.querySelector("button")?.textContent).toContain("导入历史");
    act(() => available.querySelector("button")?.click());
    expect(onImport).toHaveBeenCalledTimes(1);

    const importing = render({ kind: "importing", sessionId: "sess_1", preview });
    expect(importing.textContent).toContain("正在导入历史");
    expect(importing.querySelector("button")?.disabled).toBe(true);

    const imported = render({
      kind: "imported",
      sessionId: "sess_1",
      result: { importedEvents: 401, importedTurns: 25, lastEventSequence: 401 },
    });
    expect(imported.textContent).toContain("已导入 401 条历史记录");
    expect(imported.textContent).toContain("25 个 Turn");

    const empty = render({ kind: "empty", sessionId: "sess_1" });
    expect(empty.textContent).toContain("Provider 历史已同步");
    expect(empty.querySelector("button")).toBeNull();
  });

  it("renders only the recovery action selected by the error state", () => {
    const retryPreview = vi.fn();
    const previewError = render({
      kind: "error",
      sessionId: "sess_1",
      code: "provider_history_unavailable",
      message: "暂时无法读取 Provider 历史。",
      retry: "preview",
    }, { onRetryPreview: retryPreview });
    expect(previewError.querySelector("button")?.textContent).toContain("重试检查");
    act(() => previewError.querySelector("button")?.click());
    expect(retryPreview).toHaveBeenCalledTimes(1);

    const retryImport = vi.fn();
    const importError = render({
      kind: "error",
      sessionId: "sess_1",
      code: "unknown",
      message: "导入结果未知。",
      retry: "import",
    }, { onRetryImport: retryImport });
    expect(importError.querySelector("button")?.textContent).toContain("重试导入");
    act(() => importError.querySelector("button")?.click());
    expect(retryImport).toHaveBeenCalledTimes(1);

    const blocked = render({
      kind: "error",
      sessionId: "sess_1",
      code: "provider_history_prefix_changed",
      message: "Provider 历史前缀已变化，无法安全自动合并。",
      retry: null,
    });
    expect(blocked.textContent).toContain("无法安全自动合并");
    expect(blocked.querySelector("button")).toBeNull();
  });
});

describe("providerHistoryErrorPresentation", () => {
  it.each([
    ["confirmation_and_idempotency_key_required", null],
    ["session_not_found", null],
    ["provider_session_not_bound", null],
    ["provider_history_prefix_changed", null],
    ["provider_history_cursor_conflict", "preview"],
  ] as const)("maps %s to the locked recovery", (code, retry) => {
    expect(providerHistoryErrorPresentation({ status: 409, code }, "import").retry).toBe(retry);
  });

  it.each(["provider_history_unavailable", "runner_unavailable"] as const)(
    "retries %s in the phase that failed",
    (code) => {
      expect(providerHistoryErrorPresentation({ status: 503, code }, "preview").retry).toBe("preview");
      expect(providerHistoryErrorPresentation({ status: 503, code }, "import").retry).toBe("import");
    },
  );

  it("treats an unknown Import outcome as a same-confirmation retry", () => {
    expect(providerHistoryErrorPresentation(new TypeError("network failed"), "import"))
      .toMatchObject({ code: "unknown", retry: "import" });
  });
});
