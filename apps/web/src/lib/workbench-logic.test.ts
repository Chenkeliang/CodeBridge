import { describe, expect, it } from "vitest";
import * as workbenchLogic from "./workbench-logic";
import type { AgentSession } from "./types";

const { isModelOption, orderSessions } = workbenchLogic;

describe("workbench logic", () => {
  it("keeps non-model Agent configuration out of the model selector", () => {
    expect(isModelOption({ id: "permission", name: "Permission", type: "select", category: "mode", values: [] })).toBe(false);
    expect(isModelOption({ id: "model", name: "Model", type: "select", category: "model", values: [] })).toBe(true);
    expect(isModelOption({ id: "legacy-model-picker", name: "Model", type: "select", values: [] })).toBe(true);
  });

  it("places pinned Sessions before the most recently updated Sessions", () => {
    const session = (id: string, updatedAt: string, pinnedAt: string | null): AgentSession => ({
      session_id: id,
      agent_id: "codex",
      provider_session_id: null,
      task_record_id: null,
      flow_id: null,
      model: null,
      cwd: null,
      additional_directories: [],
      title: id,
      status: "idle",
      pinned_at: pinnedAt,
      archived_at: null,
      created_at: updatedAt,
      updated_at: updatedAt,
    });

    const ordered = orderSessions([
      session("older", "2026-08-10T00:00:00.000Z", null),
      session("pinned", "2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z"),
      session("recent", "2026-08-11T00:00:00.000Z", null),
    ]);

    expect(ordered.map((value) => value.session_id)).toEqual(["pinned", "recent", "older"]);
  });

  it("restores only the remembered Session that belongs to the selected Agent", () => {
    const restoreSession = (workbenchLogic as unknown as {
      restoreSessionSelection?: (
        sessions: AgentSession[],
        currentSessionId: string | null,
        agentId: string,
        rememberedSessionId: string | null,
      ) => string | null;
    }).restoreSessionSelection;
    expect(restoreSession).toBeTypeOf("function");
    if (!restoreSession) return;

    const session = (id: string, agentId: string): AgentSession => ({
      session_id: id,
      agent_id: agentId,
      provider_session_id: null,
      task_record_id: null,
      flow_id: null,
      model: null,
      cwd: null,
      additional_directories: [],
      title: id,
      status: "idle",
      pinned_at: null,
      archived_at: null,
      created_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z",
    });
    const sessions = [session("codex-session", "codex"), session("pi-session", "pi")];

    expect(restoreSession(sessions, null, "codex", "codex-session")).toBe("codex-session");
    expect(restoreSession(sessions, null, "codex", "pi-session")).toBeNull();
    expect(restoreSession(sessions, "codex-session", "codex", "pi-session")).toBe("codex-session");
  });

  it("offers only the current Session workspaces as @ context", () => {
    const contextPaths = (workbenchLogic as unknown as {
      workspacePaths?: (session: AgentSession | null) => string[];
    }).workspacePaths;
    expect(contextPaths).toBeTypeOf("function");
    if (!contextPaths) return;

    const session = {
      session_id: "session-1",
      agent_id: "codex",
      provider_session_id: null,
      task_record_id: null,
      flow_id: null,
      model: null,
      cwd: "/workspace/app",
      additional_directories: ["/workspace/shared", "/workspace/app"],
      title: "Session",
      status: "idle",
      pinned_at: null,
      archived_at: null,
      created_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z",
    } satisfies AgentSession;

    expect(contextPaths(session)).toEqual(["/workspace/app", "/workspace/shared"]);
    expect(contextPaths(null)).toEqual([]);
  });

  it("detects slash and workspace triggers from the active composer token", () => {
    const composerTrigger = (workbenchLogic as unknown as {
      composerTrigger?: (draft: string) => { kind: "command" | "context"; query: string } | null;
    }).composerTrigger;
    expect(composerTrigger).toBeTypeOf("function");
    if (!composerTrigger) return;

    expect(composerTrigger("/sta")).toEqual({ kind: "command", query: "sta" });
    expect(composerTrigger("检查 @src/lib")).toEqual({ kind: "context", query: "src/lib" });
    expect(composerTrigger("普通消息")).toBeNull();
    expect(composerTrigger("/status ready")).toBeNull();
  });

  it("filters commands and replaces only the active composer token", () => {
    const filterCommands = (workbenchLogic as unknown as {
      filterCommands?: (commands: Array<{ name: string; description: string }>, query: string) => Array<{ name: string }>;
    }).filterCommands;
    const applyComposerSuggestion = (workbenchLogic as unknown as {
      applyComposerSuggestion?: (draft: string, replacement: string) => string;
    }).applyComposerSuggestion;
    expect(filterCommands).toBeTypeOf("function");
    expect(applyComposerSuggestion).toBeTypeOf("function");
    if (!filterCommands || !applyComposerSuggestion) return;

    const commands = [
      { name: "status", description: "Display status" },
      { name: "skills", description: "List available skills" },
      { name: "$dcp", description: "Operate DCP workflows" },
    ];
    expect(filterCommands(commands, "").map((command) => command.name)).toEqual(["$dcp", "status", "skills"]);
    expect(filterCommands(commands, "stat").map((command) => command.name)).toEqual(["status"]);
    expect(filterCommands(commands, "available").map((command) => command.name)).toEqual(["skills"]);
    expect(applyComposerSuggestion("检查 @src/li", "@/workspace/src/lib.ts ")).toBe("检查 @/workspace/src/lib.ts ");
    expect(applyComposerSuggestion("/sta", "/status ")).toBe("/status ");
  });

  it("creates inline previews only for image attachments", () => {
    const previewUrl = (workbenchLogic as unknown as {
      attachmentPreviewUrl?: (attachment: { mimeType: string; dataBase64: string }) => string | null;
    }).attachmentPreviewUrl;
    expect(previewUrl).toBeTypeOf("function");
    if (!previewUrl) return;

    expect(previewUrl({ mimeType: "image/png", dataBase64: "aGVsbG8=" }))
      .toBe("data:image/png;base64,aGVsbG8=");
    expect(previewUrl({ mimeType: "application/pdf", dataBase64: "aGVsbG8=" }))
      .toBeNull();
  });
});
