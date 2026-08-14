import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import type { AgentSession, SessionCompositeSnapshot, SessionMessageReceipt, SessionRuntimeView, SessionTurnView } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function session(sessionId: string): AgentSession {
  return {
    session_id: sessionId,
    agent_id: "codex",
    provider_session_id: null,
    task_record_id: null,
    flow_id: null,
    model: null,
    effort: null,
    config_overrides: undefined,
    permission_mode: null,
    cwd: "/workspace",
    additional_directories: [],
    title: sessionId,
    status: "idle",
    pinned_at: null,
    archived_at: null,
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
  };
}

function runtime(last_event_sequence: number): SessionRuntimeView {
  return {
    active_run: null,
    queue_state: "ready",
    queue_pause_reason: null,
    queue: { turns: [], total: 0, next_cursor: null },
    version: 1,
    last_event_sequence,
  };
}

function receipt(turnId = "turn-1"): SessionMessageReceipt {
  const turn: SessionTurnView = {
    turn_id: turnId,
    queue_position: 0,
    status: "dispatched",
    version: 1,
    message: { text: "检查项目", attachment_ids: [] },
    created_at: "2026-08-14T00:00:01.000Z",
  };
  return {
    event_id: "event-1",
    sequence: 1,
    acceptance: "queued",
    turn,
    runtime: runtime(1),
  };
}

function snapshotResponse(sessionId: string): SessionCompositeSnapshot {
  return {
    session: session(sessionId),
    runtime: runtime(42),
    timeline: {
      turns: [],
      previous_cursor: null,
      truncated_block_ids: [],
    },
    commands: [],
    events: [],
    options: [],
    runs: [],
  };
}

describe("workbench API client", () => {
  it("can request archived Sessions for the archive view", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ sessions: [] }));
    vi.stubGlobal("fetch", fetch);

    await api.sessions(false, true);

    expect(fetch).toHaveBeenCalledWith("/v1/sessions?include_archived=true", expect.any(Object));
  });

  it("hydrates a Session from one composite snapshot request", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(snapshotResponse("session-1")));
    vi.stubGlobal("fetch", fetch);

    const result = await api.openSession("session-1");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/v1/sessions/session-1", expect.any(Object));
    expect(result.session.session_id).toBe("session-1");
    expect(result.events).toEqual([]);
  });

  it("sends the caller idempotency key with a message", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(receipt()));
    vi.stubGlobal("fetch", fetch);

    await api.sendMessage("sess_1", {
      message: "检查项目",
      flowId: null,
      model: null,
      attachments: [],
      permissionMode: null,
      effort: null,
      idempotencyKey: "message_1",
    });

    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("message_1");
  });

  it("keeps the legacy sendMessage call shape working", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(receipt()));
    vi.stubGlobal("fetch", fetch);

    await api.sendMessage("sess_1", "检查项目", null, null, [], null, null);

    expect(fetch).toHaveBeenCalledWith("/v1/sessions/sess_1/messages", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        message: "检查项目",
        flow_id: null,
        model: null,
        permission_mode: null,
        effort: null,
        attachments: [],
      }),
    }));
  });

  it("uses POST for Provider Session discovery", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ sessions: [], provider_errors: [] }));
    vi.stubGlobal("fetch", fetch);

    await api.importSessions({ cwd: "/workspace" });

    expect(fetch).toHaveBeenCalledWith("/v1/sessions/import", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ cwd: "/workspace" }),
    }));
  });

  it("throws ApiError with the response code and status", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "bad_request", message: "missing" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);

    const error = await api.agents().catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: "bad_request" });
    expect((error as Error).message).toBe("missing");
  });
});
