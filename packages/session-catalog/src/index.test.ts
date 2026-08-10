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

  it("persists pin and archive metadata while keeping archived sessions out of the default list", () => {
    const store = new SessionCatalogStore(":memory:");
    const first = store.createSession({ agentId: "codex", title: "普通会话" });
    const pinned = store.createSession({ agentId: "codex", title: "重要会话" });

    const updated = store.updateSession(pinned.id, { pinned: true, title: "置顶会话" });
    expect(updated).toMatchObject({ title: "置顶会话", pinnedAt: expect.any(String), archivedAt: null });
    expect(store.listSessions("codex").map((session) => session.id)).toEqual([pinned.id, first.id]);

    const archived = store.updateSession(pinned.id, { archived: true });
    expect(archived).toMatchObject({ pinnedAt: null, archivedAt: expect.any(String) });
    expect(store.listSessions("codex").map((session) => session.id)).toEqual([first.id]);
    expect(store.listSessions("codex", { includeArchived: true }).map((session) => session.id)).toEqual(expect.arrayContaining([pinned.id, first.id]));

    expect(store.updateSession(pinned.id, { archived: false })?.archivedAt).toBeNull();
    store.close();
  });

  it("binds an external channel conversation to the same Session contract", () => {
    const store = new SessionCatalogStore(":memory:");
    const session = store.createSession({ agentId: "pi" });
    const binding = store.bindChannelConversation("feishu", "chat:topic", session.id);
    expect(binding).toMatchObject({ channel: "feishu", conversationId: "chat:topic", sessionId: session.id });
    expect(store.getChannelSession("feishu", "chat:topic")).toEqual(session);
    expect(store.bindChannelConversation("feishu", "chat:topic", session.id).createdAt).toBe(binding.createdAt);
    expect(store.unbindChannelConversation("feishu", "chat:topic")).toBe(true);
    expect(store.getChannelSession("feishu", "chat:topic")).toBeUndefined();
    store.close();
  });
});
