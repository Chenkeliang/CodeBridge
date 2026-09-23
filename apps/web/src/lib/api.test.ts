import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ApiError, api, streamSessionEvents } from "./api";
import type {
  AgentSession,
  SessionCompositeSnapshot,
  SessionMessageReceipt,
  SessionRuntimeView,
  SessionTurnView,
} from "./types";

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
    flow_definition_revision: null,
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

function sessionWireEvent() {
  return {
    schema_version: 1 as const,
    event_id: "evt_1",
    sequence: 1,
    work_item_id: "work_1",
    run_id: "run_1",
    execution_kind: "agent",
    type: "RUN_SUCCEEDED",
    occurred_at: "2026-08-24T00:00:00.000Z",
    actor: "system",
    target: null,
    input_hash: null,
    result_ref: "result://final",
    payload: {},
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
  it("consumes the canonical Session event from live SSE", async () => {
    const event = sessionWireEvent();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `data: ${JSON.stringify(event)}\n\n`,
      { headers: { "content-type": "text/event-stream; charset=utf-8" } },
    )));
    const received: unknown[] = [];

    await streamSessionEvents(
      "sess_1",
      0,
      new AbortController().signal,
      (candidate) => received.push(candidate),
    );

    expect(received).toEqual([event]);
  });

  it("requires the Session SSE transport contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ events: [] })));

    await expect(streamSessionEvents(
      "sess_1",
      0,
      new AbortController().signal,
      () => {},
    )).rejects.toThrow("session_event_transport_mismatch");
  });

  it("rejects malformed Session event frames before they reach the store", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      'data: {"type":"RUN_SUCCEEDED","sequence":1,"runId":"run_1"}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    )));

    await expect(streamSessionEvents(
      "sess_1",
      0,
      new AbortController().signal,
      () => {},
    )).rejects.toThrow("session_event_schema_mismatch");
  });

  it("uses the existing Runtime approval query and write contracts", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ approvals: [{ id: "approval_1", status: "requested" }] }))
      .mockResolvedValueOnce(Response.json({ approval_id: "approval_1", status: "granted" }))
      .mockResolvedValueOnce(Response.json({ approval_id: "approval_1", status: "revoked" }));
    vi.stubGlobal("fetch", fetch);

    await api.approvals("run_1");
    await api.approve("run_1", "approval_1");
    await api.reject("run_1", "approval_1");

    expect(fetch.mock.calls[0]?.[0]).toBe("/v1/runs/run_1/approvals");
    expect(fetch.mock.calls[1]).toEqual([
      "/v1/runs/run_1/approve",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ approval_id: "approval_1" }) }),
    ]);
    expect(fetch.mock.calls[2]).toEqual([
      "/v1/runs/run_1/reject",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ approval_id: "approval_1" }) }),
    ]);
  });

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
      model: null,
      attachments: [],
      permissionMode: null,
      effort: null,
      idempotencyKey: "message_1",
    });

    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("message_1");
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty("flow_id");
    expect(body).not.toHaveProperty("definition_revision");
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

  it("exposes the response body on ApiError for missing_inputs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "missing_inputs",
      missing: [{ id: "text", type: "string", source: "user", reason: "required" }],
    }), { status: 409, headers: { "content-type": "application/json" } })));
    const error = await api.sendMessage("sess_1", {
      message: "run", model: null,
      attachments: [], permissionMode: null, effort: null, idempotencyKey: "k2",
    }).catch((caught) => caught) as ApiError;
    expect(error.code).toBe("missing_inputs");
    expect(error.body).toMatchObject({ missing: [{ id: "text" }] });
  });

  it("preserves the structured revision mismatch error body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "flow_revision_mismatch",
      source: "binding",
      flow_id: "flow_demo",
      expected_definition_revision: "sha256:old",
      current_definition_revision: "sha256:new",
      requires_confirmation: true,
    }), { status: 409, headers: { "content-type": "application/json" } })));
    const error = await api.sendMessage("sess_1", {
      message: "run",
      model: null,
      attachments: [],
      permissionMode: null,
      effort: null,
      idempotencyKey: "revision-mismatch",
    }).catch((caught) => caught) as ApiError;
    expect(error.code).toBe("flow_revision_mismatch");
    expect(error.body).toMatchObject({
      source: "binding",
      flow_id: "flow_demo",
      expected_definition_revision: "sha256:old",
      current_definition_revision: "sha256:new",
      requires_confirmation: true,
    });
  });

  it("previews Provider history without a key and imports with the caller key", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        providerSessionId: "provider-session-1",
        importedPosition: 0,
        providerPosition: 401,
        importableEvents: 401,
        nextDigest: "sha256:preview",
      }))
      .mockResolvedValueOnce(Response.json({
        importedEvents: 401,
        importedTurns: 25,
        lastEventSequence: 401,
      }));
    vi.stubGlobal("fetch", fetch);

    await api.previewProviderHistory("sess_1");
    await api.importProviderHistory("sess_1", "history-confirm-1");

    expect(fetch.mock.calls[0]).toEqual([
      "/v1/sessions/sess_1/provider-history/preview",
      expect.objectContaining({ method: "POST" }),
    ]);
    expect(new Headers((fetch.mock.calls[0]?.[1] as RequestInit).headers).has("Idempotency-Key"))
      .toBe(false);

    const importInit = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(fetch.mock.calls[1]?.[0]).toBe("/v1/sessions/sess_1/provider-history/import");
    expect(importInit.method).toBe("POST");
    expect(new Headers(importInit.headers).get("Idempotency-Key"))
      .toBe("history-confirm-1");
    expect(JSON.parse(String(importInit.body))).toEqual({ confirm: true });
  });
});

it("uses the Skill catalog, preview, and plan apply contracts", async () => {
    const snapshot = {
      skills: [], targets: [],
      summary: { total: 0, sources: 0, linked: 0, issues: 0 },
      scanned_at: "2026-08-24T00:00:00.000Z",
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json({ plan_id: "plan-1", kind: "assignment" }))
      .mockResolvedValueOnce(Response.json({ plan_id: "plan-1", transaction_id: "tx-1" }));
    vi.stubGlobal("fetch", fetch);
    const input = { skill_id: "skill-1", agent_id: "claude" as const, enabled: true };

    await api.skills();
    await api.pickSkillSource();
    await api.previewSkillAssignment(input);
    await api.applySkillPlan("assignment", "plan-1");

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/v1/skills",
      "/v1/skills/sources/pick",
      "/v1/skills/assignments/preview",
      "/v1/skills/assignment-plans/plan-1/apply",
    ]);
    expect(fetch).toHaveBeenNthCalledWith(2, "/v1/skills/sources/pick", expect.objectContaining({
      method: "POST",
    }));
    expect(fetch).toHaveBeenNthCalledWith(3, "/v1/skills/assignments/preview", expect.objectContaining({
      method: "POST",
      body: JSON.stringify(input),
    }));
  });
