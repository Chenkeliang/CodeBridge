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
        dry_run: false,
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

  it("carries inputs and dry_run on sendMessage", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(receipt()));
    vi.stubGlobal("fetch", fetch);

    await api.sendMessage("sess_1", {
      message: "run", flowId: "flow_demo_echo", definitionRevision: "sha256:one", model: null,
      attachments: [], permissionMode: null, effort: null, idempotencyKey: "k",
      inputs: { text: "hi" }, dryRun: true,
    });

    const body = JSON.parse(String((fetch.mock.calls.at(-1)?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      flow_id: "flow_demo_echo",
      definition_revision: "sha256:one",
      inputs: { text: "hi" },
      dry_run: true,
    });
  });

  it("exposes the response body on ApiError for missing_inputs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "missing_inputs",
      missing: [{ id: "text", type: "string", source: "user", reason: "required" }],
    }), { status: 409, headers: { "content-type": "application/json" } })));
    const error = await api.sendMessage("sess_1", {
      message: "run", flowId: "flow_demo_echo", model: null,
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

  it.each(["manage", "consume"] as const)("lists the explicit %s Flow view", async (view) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ flows: [] }));
    vi.stubGlobal("fetch", fetch);
    await api.flows(view);
    expect(fetch).toHaveBeenCalledWith(`/v1/flows?view=${view}`, expect.any(Object));
  });

  it("applies and unbinds Flow through explicit APIs", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        flow_id: "flow_demo",
        definition_revision: "sha256:one",
      }))
      .mockResolvedValueOnce(Response.json(session("sess_1")));
    vi.stubGlobal("fetch", fetch);
    await api.applyFlow("sess_1", "flow_demo");
    await api.unbindFlow("sess_1");
    expect(fetch).toHaveBeenNthCalledWith(1, "/v1/flows/flow_demo/apply", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ session_id: "sess_1" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, "/v1/sessions/sess_1/flow", expect.objectContaining({
      method: "DELETE",
    }));
  });

  it("fetches a flow by id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      flow_id: "flow_demo_echo", plan_ir_hash: "sha256:plan",
    })));
    const flow = await api.fetchFlow("flow_demo_echo");
    expect(flow).toMatchObject({ flow_id: "flow_demo_echo", plan_ir_hash: "sha256:plan" });
  });
});
