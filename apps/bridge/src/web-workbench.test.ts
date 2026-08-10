import { describe, expect, it } from "vitest";
import { Script } from "node:vm";
import { SqliteEventStore } from "@codebridge/work-items";
import { createWebWorkbenchApp } from "./web-workbench.js";

describe("web workbench", () => {
  it("serves a chat-first workbench with optional agent and workflow context", async () => {
    const store = new SqliteEventStore(":memory:");
    const app = createWebWorkbenchApp({
      store,
      token: "web-token",
    });
    const response = await app.request("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Agents");
    expect(html).toContain("Flows");
    expect(html).toContain("New session");
    expect(html).toContain("Workflow");
    expect(html).toContain("Agent · 自动选择");
    expect(html).toContain("Workflow · 自动发现");
    expect(html).toContain("Agent 会先理解目标，再决定合适的上下文与下一步");
    expect(html).not.toContain('<label>模式');
    expect(html).not.toContain('<label>项目范围');
    expect(html).not.toContain('id="work-title"');
    expect(html).not.toContain('id="cancel-new"');
    expect(html).toContain('id="mode"');
    expect(html).toContain("模式 · Agent 判断");
    expect(html).toContain('id="workspace"');
    expect(html).toContain('id="workspace-authorize"');
    expect(html).toContain('id="model"');
    expect(html).toContain('id="reply-model"');
    expect(html).toContain("Folder / 工作目录（可选）");
    expect(html).toContain("/v1/directories/authorize");
    expect(html).toContain('id="save-flow"');
    expect(html).toContain("/v1/flows/candidates");
    expect(html).toContain('id="accept-project"');
    expect(html).toContain("/v1/projects/candidates/");
    expect(html).toContain('id="approve-run"');
    expect(html).toContain('id="reject-run"');
    expect(html).toContain("/v1/runs/");
    expect(html).toContain("/review");
    expect(html).toContain('id="session-fork"');
    expect(html).toContain('id="session-close"');
    expect(html).toContain('id="session-delete"');
    expect(html).toContain('id="session-directories"');
    expect(html).toContain('id="directory-panel"');
    expect(html).toContain('id="additional-directory"');
    expect(html).toContain('id="add-directory"');
    expect(html).toContain("/directories");
    expect(html).toContain("additional_directories");
    expect(html).toContain('id="run-inspector"');
    expect(html).toContain('id="run-state"');
    expect(html).toContain('id="approval-list"');
    expect(html).toContain('id="artifact-list"');
    expect(html).toContain('id="verification-list"');
    expect(html).toContain('id="artifact-content"');
    expect(html).toContain("/artifacts");
    expect(html).toContain("/verifications");
    expect(html).toContain("/approvals");
    expect(html).toContain('id="project-drift-list"');
    expect(html).toContain("/v1/projects/drifts");
    expect(html).toContain('data-drift-action="apply"');
    expect(html).toContain('data-drift-action="resolve"');
    expect(html).toContain('id="attachment-picker"');
    expect(html).toContain('id="reply-attachment-picker"');
    expect(html).toContain('id="attachment-list"');
    expect(html).toContain('id="reply-attachment-list"');
    expect(html).toContain("data_base64");
    expect(html).toContain("mime_type");
    expect(html).toContain('data-view="plan"');
    expect(html).toContain('data-view="approval"');
    expect(html).toContain('data-view="evidence"');
    expect(html).not.toContain("模式 · 发布");
    expect(html).not.toContain("模式 · 调查");
    expect(html).not.toContain("权益");
    expect(html).not.toContain("订单号");
    expect(html).not.toContain("日志片段");
    expect(html).not.toContain("示例");
    expect(html).not.toContain("price-change");
    expect(html).not.toContain("自动生成");
    expect(html).toContain("/v1/sessions");
    expect(html).toContain("events?live=true&after_sequence=");
    expect(html).not.toContain("@ 委派");
    store.close();
  });

  it("emits browser-parseable JavaScript", async () => {
    const store = new SqliteEventStore(":memory:");
    const app = createWebWorkbenchApp({ store, token: "web-token" });
    const html = await (await app.request("/")).text();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];

    expect(script).toBeDefined();
    expect(() => new Script(script!)).not.toThrow();
    store.close();
  });

  it("keeps hidden workbench regions out of the layout", async () => {
    const store = new SqliteEventStore(":memory:");
    const app = createWebWorkbenchApp({ store, token: "web-token" });
    const html = await (await app.request("/")).text();

    expect(html).toContain("[hidden] { display:none !important; }");
    store.close();
  });

  it("loads local sessions before an explicit provider sync", async () => {
    const store = new SqliteEventStore(":memory:");
    const app = createWebWorkbenchApp({ store, token: "web-token" });
    const html = await (await app.request("/")).text();

    expect(html).toContain('id="sync-sessions"');
    expect(html).toContain("const result = await api('/v1/sessions');");
    expect(html).toContain("async function syncSessions()");
    store.close();
  });

  it("hides context selectors that have no choices", async () => {
    const store = new SqliteEventStore(":memory:");
    const app = createWebWorkbenchApp({ store, token: "web-token" });
    const html = await (await app.request("/")).text();

    expect(html).toMatch(/<select[^>]*id="mode"[^>]*hidden/);
    expect(html).toMatch(/<select[^>]*id="workflow"[^>]*hidden/);
    expect(html).toMatch(/<select[^>]*id="model"[^>]*hidden/);
    store.close();
  });

  it("hides timeline filters until a session is selected", async () => {
    const store = new SqliteEventStore(":memory:");
    const app = createWebWorkbenchApp({ store, token: "web-token" });
    const html = await (await app.request("/")).text();

    expect(html).toContain('id="timeline-toolbar" hidden');
    store.close();
  });

  it("keeps long session history inside the sidebar", async () => {
    const store = new SqliteEventStore(":memory:");
    const app = createWebWorkbenchApp({ store, token: "web-token" });
    const html = await (await app.request("/")).text();

    expect(html).toContain("#work-list { flex:1 1 auto; min-height:0; }");
    store.close();
  });

  it("does not allow new sessions for unavailable agents", async () => {
    const store = new SqliteEventStore(":memory:");
    const app = createWebWorkbenchApp({
      store,
      token: "web-token",
      agentProfiles: [
        { id: "codex", name: "Codex", status: "healthy" },
        { id: "pi", name: "Pi", status: "needs_setup" },
      ],
    });
    const html = await (await app.request("/")).text();

    expect(html).toContain('<option value="pi" disabled>Pi · needs_setup</option>');
    store.close();
  });

  it("stops session polling before deleting a session", async () => {
    const store = new SqliteEventStore(":memory:");
    const app = createWebWorkbenchApp({ store, token: "web-token" });
    const html = await (await app.request("/")).text();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

    expect(script).toMatch(/session-delete[\s\S]*clearInterval\(state\.timer\); state\.eventAbort\?\.abort\(\);[\s\S]*method:'DELETE'/);
    store.close();
  });

  it("reconnects the event stream after the first message creates a work item", async () => {
    const store = new SqliteEventStore(":memory:");
    const app = createWebWorkbenchApp({ store, token: "web-token" });
    const html = await (await app.request("/")).text();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

    expect(script).toMatch(/await api\('\/v1\/sessions\/' \+ encodeURIComponent\(state\.selected\) \+ '\/messages'[\s\S]*?await startRun\(\); state\.eventAbort\?\.abort\(\); void startEventStream\(\);/);
    store.close();
  });

  it("does not request an authenticated favicon", async () => {
    const store = new SqliteEventStore(":memory:");
    const app = createWebWorkbenchApp({ store, token: "web-token" });
    const html = await (await app.request("/")).text();

    expect(html).toContain('<link rel="icon" href="data:," />');
    store.close();
  });
});
