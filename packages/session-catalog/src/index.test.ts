import { describe, expect, it } from "vitest";
import { SessionCatalogStore } from "./index.js";

describe("session catalog", () => {
  it("persists sessions grouped by Agent Profile", () => {
    const store = new SessionCatalogStore(":memory:");
    const codex = store.createSession({ agentId: "codex", title: "分析问题" });
    store.createSession({ agentId: "pi", title: "检查目录" });

    expect(store.listSessions("codex")).toEqual([codex]);
    expect(store.getSession(codex.id)).toMatchObject({
      agentId: "codex",
      title: "分析问题",
      status: "idle",
    });
    store.close();
  });

  it("updates a session provider binding and lifecycle", () => {
    const store = new SessionCatalogStore(":memory:");
    const session = store.createSession({ agentId: "cursor", cwd: "/tmp/project" });

    const bound = store.updateSession(session.id, {
      providerSessionId: "provider-1",
      status: "active",
      title: "恢复会话",
    });
    expect(bound).toMatchObject({
      providerSessionId: "provider-1",
      cwd: "/tmp/project",
      status: "active",
      title: "恢复会话",
    });

    expect(store.updateSession(session.id, { status: "closed" })?.status).toBe("closed");
    expect(store.deleteSession(session.id)).toBe(true);
    expect(store.getSession(session.id)).toBeUndefined();
    store.close();
  });
});
