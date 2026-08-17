import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { canonicalWorkspaceKey, type ChannelSlot } from "@codebridge/core";
import { SessionCatalogStore } from "./index.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

function slot(
  agentId: string,
  workspaceKey: string,
  generation = 0,
): ChannelSlot {
  return {
    channel: "feishu",
    conversationId: "chat:topic",
    agentId,
    workspaceKey,
    generation,
  };
}

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

  it("persists a Session permission mode override", () => {
    const store = new SessionCatalogStore(":memory:");
    const session = store.createSession({ agentId: "codex" });

    const updated = store.updateSession(session.id, {
      permissionMode: "agent-full-access",
    } as never);

    expect(updated).toMatchObject({ permissionMode: "agent-full-access" });
    expect(store.getSession(session.id)).toMatchObject({ permissionMode: "agent-full-access" });
    store.close();
  });

  it("persists a Session reasoning effort override", () => {
    const store = new SessionCatalogStore(":memory:");
    const session = store.createSession({ agentId: "codex" });

    const updated = store.updateSession(session.id, { effort: "xhigh" } as never);

    expect(updated).toMatchObject({ effort: "xhigh" });
    expect(store.getSession(session.id)).toMatchObject({ effort: "xhigh" });
    store.close();
  });

  it("persists arbitrary Agent config overrides for a Session", () => {
    const store = new SessionCatalogStore(":memory:");
    const session = store.createSession({ agentId: "codex" });

    const updated = store.updateSession(session.id, {
      configOverrides: { "fast-mode": true, output_style: "concise" },
    });

    expect(updated).toMatchObject({
      configOverrides: { "fast-mode": true, output_style: "concise" },
    });
    expect(store.getSession(session.id)).toMatchObject({
      configOverrides: { "fast-mode": true, output_style: "concise" },
    });
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
    const session = store.createSession({ agentId: "pi", cwd: "/tmp/project" });
    const key = canonicalWorkspaceKey("/tmp/project").key;
    const binding = store.bindChannelConversation(slot("pi", key), session.id);
    expect(binding).toMatchObject({
      channel: "feishu",
      conversationId: "chat:topic",
      agentId: "pi",
      workspaceKey: key,
      generation: 0,
      sessionId: session.id,
    });
    expect(store.getChannelSession(slot("pi", key))).toEqual(session);
    expect(store.bindChannelConversation(slot("pi", key), session.id).createdAt).toBe(binding.createdAt);
    expect(store.unbindChannelConversation(slot("pi", key))).toBe(true);
    expect(store.getChannelSession(slot("pi", key))).toBeUndefined();
    store.close();
  });

  it("binds pi and cursor to distinct sessions for the same channel+conversation", () => {
    const store = new SessionCatalogStore(":memory:");
    const pi = store.createSession({ agentId: "pi", cwd: "/tmp/project" });
    const cursor = store.createSession({ agentId: "cursor", cwd: "/tmp/project" });
    const key = canonicalWorkspaceKey("/tmp/project").key;
    store.bindChannelConversation(slot("pi", key), pi.id);
    store.bindChannelConversation(slot("cursor", key), cursor.id);

    expect(store.getChannelSession(slot("pi", key))?.id).toBe(pi.id);
    expect(store.getChannelSession(slot("cursor", key))?.id).toBe(cursor.id);
    store.close();
  });

  it("bindHistoricalSession is insert-only and idempotent for the same session", () => {
    const store = new SessionCatalogStore(":memory:");
    const key = canonicalWorkspaceKey("/tmp/project").key;
    const first = store.createSession({ agentId: "pi", cwd: "/tmp/project" });
    const second = store.createSession({ agentId: "pi", cwd: "/tmp/project" });

    const bound = store.bindHistoricalSession(slot("pi", key), first.id);
    expect(bound.sessionId).toBe(first.id);
    // 幂等：同 slot 绑同 session 返回既有
    expect(store.bindHistoricalSession(slot("pi", key), first.id).sessionId).toBe(first.id);
    // 不同 session → 冲突
    expect(() => store.bindHistoricalSession(slot("pi", key), second.id)).toThrow(
      "slot_already_bound",
    );
    store.close();
  });

  it("getOrCreateBoundSession reuses the bound session and is atomic", () => {
    const store = new SessionCatalogStore(":memory:");
    const key = canonicalWorkspaceKey("/tmp/project").key;
    const created = store.getOrCreateBoundSession(slot("pi", key), {
      agentId: "pi",
      cwd: "/tmp/project",
    });
    const reused = store.getOrCreateBoundSession(slot("pi", key), {
      agentId: "pi",
      cwd: "/tmp/project",
    });
    expect(reused.id).toBe(created.id);
    expect(store.listSessions("pi")).toHaveLength(1);
    store.close();
  });

  it("migrates legacy (channel, conversation_id) bindings and skips orphans", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-catalog-"));
    const dbPath = path.join(dir, "catalog.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        provider_session_id TEXT,
        task_record_id TEXT,
        flow_id TEXT,
        model TEXT,
        effort TEXT,
        config_overrides TEXT NOT NULL,
        permission_mode TEXT,
        folder_id TEXT,
        cwd TEXT,
        additional_directories TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL,
        pinned_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE channel_session_bindings (
        channel TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (channel, conversation_id)
      );
    `);
    db.prepare(
      `INSERT INTO agent_sessions (id, schema_version, agent_id, cwd, config_overrides, additional_directories, status, created_at, updated_at)
       VALUES ('sess_legacy', 1, 'pi', NULL, '{}', '[]', 'idle', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO channel_session_bindings (channel, conversation_id, session_id, created_at, updated_at)
       VALUES ('feishu', 'chat:topic', 'sess_legacy', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO channel_session_bindings (channel, conversation_id, session_id, created_at, updated_at)
       VALUES ('feishu', 'chat:orphan', 'sess_missing', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
    ).run();
    db.close();

    const store = new SessionCatalogStore(dbPath, { defaultCwd: "/default/ws" });
    const migrated = store.getChannelSession({
      channel: "feishu",
      conversationId: "chat:topic",
      agentId: "pi",
      workspaceKey: canonicalWorkspaceKey("/default/ws").key,
      generation: 0,
    });
    expect(migrated?.id).toBe("sess_legacy");
    expect(store.getChannelSession({
      channel: "feishu",
      conversationId: "chat:orphan",
      agentId: "pi",
      workspaceKey: canonicalWorkspaceKey("/default/ws").key,
      generation: 0,
    })).toBeUndefined();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
