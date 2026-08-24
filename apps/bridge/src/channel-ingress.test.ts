import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  createChannelIngressApi,
  createChannelSessionIngress,
} from "./channel-ingress.js";

function sse(events: string[]): Response {
  return new Response(
    events.map((data) => `data: ${data}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("channel session ingress", () => {
  it("mounts both Session and Flow APIs for production channel commands", async () => {
    const sessionApp = new Hono();
    sessionApp.get("/v1/sessions/:sessionId", (c) => c.json({
      session_id: c.req.param("sessionId"),
    }));
    const flowApp = new Hono();
    flowApp.get("/v1/flows", (c) => c.json({
      flows: [{
        flow_id: "flow_demo",
        name: "Demo",
        definition_revision: "sha256:one",
      }],
    }));

    const api = createChannelIngressApi(sessionApp, flowApp);
    const ingress = createChannelSessionIngress(api, "token");

    await expect(ingress.listConsumableFlows()).resolves.toEqual([{
      flowId: "flow_demo",
      name: "Demo",
      definitionRevision: "sha256:one",
      inputs: [],
      steps: [],
    }]);
    const sessionResponse = await api.request("/v1/sessions/sess_1");
    expect(sessionResponse.status).toBe(200);
  });

  it("submits a channel message and returns a receipt", async () => {
    const app = new Hono();
    app.post("/v1/channels/:channel/conversations/:conversation/messages", async (c) => {
      expect(c.req.param("channel")).toBe("feishu");
      const body = await c.req.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        message: "hello",
        agent_id: "pi",
        generation: 0,
        reply_to_message_id: "msg_1",
      });
      expect(body).not.toHaveProperty("flow_id");
      expect(body).not.toHaveProperty("definition_revision");
      return c.json({
        session_id: "sess_1",
        turn_id: "turn_1",
        run_id: "run_1",
        acceptance: "dispatched",
        queue_state: "ready",
        event_sequence: 3,
      }, 202);
    });
    const ingress = createChannelSessionIngress(app, "token");
    const receipt = await ingress.submit({
      channel: "feishu",
      conversationId: "chat|topic",
      message: "hello",
      agentId: "pi",
      generation: 0,
      replyToMessageId: "msg_1",
    });
    expect(receipt).toEqual({
      sessionId: "sess_1",
      turnId: "turn_1",
      runId: "run_1",
      acceptance: "dispatched",
      queueState: "ready",
      eventSequence: 3,
    });
  });

  it("submits a complete Flow invocation and actor identity", async () => {
    const app = new Hono();
    app.post("/v1/channels/:channel/conversations/:conversation/messages", async (c) => {
      expect(await c.req.json()).toMatchObject({
        flow_id: "flow_demo",
        definition_revision: "sha256:one",
        inputs: { oid: 1644460 },
        actor_ref: { channel: "telegram", id: "user_1" },
      });
      return c.json({
        session_id: "sess_1",
        turn_id: "turn_1",
        run_id: "run_1",
        acceptance: "dispatched",
        queue_state: "ready",
        event_sequence: 3,
      }, 202);
    });
    const ingress = createChannelSessionIngress(app, "token");
    await ingress.submit({
      channel: "telegram",
      conversationId: "chat|topic",
      message: "run",
      flowId: "flow_demo",
      flowDefinitionRevision: "sha256:one",
      inputs: { oid: 1644460 },
      actorRef: { channel: "telegram", id: "user_1" },
    });
  });

  it.each([
    { flowId: "flow_demo" },
    { flowDefinitionRevision: "sha256:one" },
  ])("rejects an incomplete channel Flow invocation", async (partial) => {
    const app = new Hono();
    const ingress = createChannelSessionIngress(app, "token");
    await expect(ingress.submit({
      channel: "feishu",
      conversationId: "chat",
      message: "run",
      ...partial,
    })).rejects.toThrow("flow_invocation_incomplete");
  });

  it("lists only the fixed consume view", async () => {
    const app = new Hono();
    app.get("/v1/flows", (c) => {
      expect(c.req.query("view")).toBe("consume");
      return c.json({
        flows: [{
          flow_id: "flow_demo",
          name: "Demo",
          definition_revision: "sha256:one",
          inputs: [{
            id: "oid",
            type: "integer",
            source: "user",
            required: true,
          }],
          steps: [{
            id: "lookup",
            purpose: "查订单",
            mode: "read_only",
            approval: "none",
          }],
        }],
      });
    });
    const ingress = createChannelSessionIngress(app, "token");
    await expect(ingress.listConsumableFlows()).resolves.toEqual([{
      flowId: "flow_demo",
      name: "Demo",
      definitionRevision: "sha256:one",
      inputs: [{
        id: "oid",
        type: "integer",
        source: "user",
        required: true,
      }],
      steps: [{
        id: "lookup",
        purpose: "查订单",
        mode: "read_only",
        approval: "none",
      }],
    }]);
  });

  it("adapts Flow management calls without moving domain rules into channels", async () => {
    const app = new Hono();
    const candidate = {
      flow_id: "flow_candidate", name: "Candidate", description: "Draft", definition_revision: "sha256:one",
      kind: "runbook", status: "candidate", review_status: "pending", validation_issues: [],
    };
    app.get("/v1/flows", (c) => {
      expect(c.req.query("view")).toBe("manage");
      return c.json({ flows: [candidate] });
    });
    app.get("/v1/sessions/:session/flow-proposals", (c) => c.json({ proposals: [{ run_id: "run_1", saveable: true }] }));
    app.post("/v1/flows/guides", async (c) => {
      expect(await c.req.json()).toEqual({ session_id: "sess_1", run_id: "run_1" });
      return c.json({ ...candidate, flow_id: "flow_guide", kind: "guide", status: "draft" }, 201);
    });
    app.get("/v1/flows/:flow/review-context", (c) => c.json({
      flow: candidate,
      diff: { name_changed: true, description_changed: false, inputs: {}, steps: { changed: ["lookup"] } },
      provenance: { source_run_id: "run_1", source_session_id: "sess_1" },
      evidence: [{}],
    }));
    app.patch("/v1/flows/:flow/summary", async (c) => c.json({ ...candidate, ...(await c.req.json()) }));
    app.post("/v1/flows/:flow/review", async (c) => {
      expect(await c.req.json()).toEqual({ decision: "reject" });
      return c.json({ ...candidate, review_status: "rejected" });
    });

    const ingress = createChannelSessionIngress(app, "token");
    await expect(ingress.listManageableFlows?.()).resolves.toMatchObject([{ flowId: "flow_candidate", status: "candidate" }]);
    await expect(ingress.saveLatestGuide?.("sess_1")).resolves.toMatchObject({ flowId: "flow_guide", kind: "guide" });
    await expect(ingress.getFlowReviewSummary?.("flow_candidate")).resolves.toMatchObject({ changedFields: ["name", "step ~lookup"], evidenceCount: 1 });
    await expect(ingress.updateCandidateSummary?.("flow_candidate", { name: "New" })).resolves.toMatchObject({ name: "New" });
    await expect(ingress.rejectCandidate?.("flow_candidate")).resolves.toMatchObject({ reviewStatus: "rejected" });
  });

  it("adapts Flow batch reads and commands through the shared API", async () => {
    const app = new Hono();
    const counts = {
      total: 2, queued: 1, running: 1, waiting: 0,
      succeeded: 0, failed: 0, cancelled: 0,
    };
    app.get("/v1/flow-invocation-drafts/:draft", (c) => c.json({
      draft_id: c.req.param("draft"),
      session_id: "sess_1",
      flow_id: "flow_orders",
      definition_revision: "sha256:def",
      status: "ready",
      revision: 2,
      items: [{ issues: [] }, { issues: [{ blocking: true }] }],
    }));
    app.post("/v1/flow-invocation-drafts/:draft/confirm", async (c) => {
      expect(c.req.header("idempotency-key")).toBe("confirm-1");
      expect(await c.req.json()).toEqual({
        draft_revision: 2,
        created_by: "channel",
      });
      return c.json({
        batch_id: "batch_1", draft_id: c.req.param("draft"), session_id: "sess_1",
        flow_id: "flow_orders", definition_revision: "sha256:def", status: "running", counts,
      }, 202);
    });
    app.get("/v1/flow-batches/:batch", (c) => c.json({
      batch_id: c.req.param("batch"), draft_id: "draft_1", session_id: "sess_1",
      flow_id: "flow_orders", definition_revision: "sha256:def", status: "running", counts,
    }));
    app.post("/v1/flow-batches/:batch/cancel", (c) => c.json({
      batch_id: c.req.param("batch"), draft_id: "draft_1", session_id: "sess_1",
      flow_id: "flow_orders", definition_revision: "sha256:def", status: "cancelled",
      counts: { ...counts, queued: 0, running: 0, cancelled: 2 },
    }));
    app.post("/v1/flow-batches/:batch/retry-failed", (c) => c.json({
      batch_id: c.req.param("batch"), draft_id: "draft_1", session_id: "sess_1",
      flow_id: "flow_orders", definition_revision: "sha256:def", status: "running", counts,
    }));

    const ingress = createChannelSessionIngress(app, "token");
    await expect(ingress.getFlowBatchDraft?.("draft_1")).resolves.toMatchObject({
      draftId: "draft_1", total: 2, blocking: 1,
    });
    await expect(ingress.confirmFlowBatchDraft?.("draft_1", 2, "confirm-1"))
      .resolves.toMatchObject({ batchId: "batch_1", status: "running", counts });
    await expect(ingress.getFlowBatch?.("batch_1")).resolves.toMatchObject({ batchId: "batch_1" });
    await expect(ingress.cancelFlowBatch?.("batch_1")).resolves.toMatchObject({ status: "cancelled" });
    await expect(ingress.retryFailedFlowBatch?.("batch_1", "retry-1")).resolves.toMatchObject({ batchId: "batch_1" });
  });

  it("lists and resolves Runtime step approvals through the existing APIs", async () => {
    const app = new Hono();
    app.get("/v1/runs/:run/approvals", (c) => {
      expect(c.req.param("run")).toBe("run_1");
      return c.json({
        approvals: [{
          id: "approval_1",
          run_id: "run_1",
          step_id: "deploy",
          capability_id: "deploy.release",
          status: "requested",
          environment: "production",
          target_resource: "service:bridge",
          expires_at: "2026-08-21T15:00:00.000Z",
        }],
      });
    });
    app.post("/v1/runs/:run/approve", async (c) => {
      expect(c.req.param("run")).toBe("run_1");
      expect(await c.req.json()).toEqual({ approval_id: "approval_1" });
      return c.json({
        approval_id: "approval_1",
        status: "granted",
        granted_at: "2026-08-21T14:30:00.000Z",
      });
    });
    app.post("/v1/runs/:run/reject", async (c) => {
      expect(await c.req.json()).toEqual({ approval_id: "approval_1" });
      return c.json({ approval_id: "approval_1", status: "revoked" });
    });

    const ingress = createChannelSessionIngress(app, "token");
    await expect(ingress.listRuntimeApprovals?.("run_1")).resolves.toEqual([{
      id: "approval_1",
      runId: "run_1",
      stepId: "deploy",
      capabilityId: "deploy.release",
      status: "requested",
      environment: "production",
      targetResource: "service:bridge",
      expiresAt: "2026-08-21T15:00:00.000Z",
    }]);
    await expect(
      ingress.resolveRuntimeApproval?.("run_1", "approval_1", "approve"),
    ).resolves.toMatchObject({ id: "approval_1", status: "granted" });
    await expect(
      ingress.resolveRuntimeApproval?.("run_1", "approval_1", "reject"),
    ).resolves.toMatchObject({ id: "approval_1", status: "revoked" });
  });

  it("resumes a provider session into a slot", async () => {
    const app = new Hono();
    app.post("/v1/channels/:channel/conversations/:conversation/resume", async (c) => {
      expect(c.req.param("channel")).toBe("feishu");
      expect(c.req.param("conversation")).toBe("chat|topic");
      expect(await c.req.json()).toEqual({
        agent_id: "pi",
        workspace_key: "ws_1",
        generation: 3,
        provider_session_id: "provider_old",
      });
      return c.json({ session_id: "sess_9" }, 200);
    });
    const ingress = createChannelSessionIngress(app, "token");
    const result = await ingress.resumeProviderSession({
      channel: "feishu",
      conversationId: "chat|topic",
      agentId: "pi",
      workspaceKey: "ws_1",
      generation: 3,
    }, "provider_old");
    expect(result).toEqual({ sessionId: "sess_9" });
  });

  it("throws the provider_session_busy code with detail on the error", async () => {
    const app = new Hono();
    app.post("/v1/channels/:channel/conversations/:conversation/resume", async (c) => {
      return c.json({
        error: "provider_session_busy",
        detail: "provider session p 正被 run r 使用",
      }, 409);
    });
    const ingress = createChannelSessionIngress(app, "token");
    let thrown: Error & { detail?: string } | undefined;
    try {
      await ingress.resumeProviderSession({
        channel: "feishu",
        conversationId: "chat|topic",
        agentId: "pi",
        workspaceKey: "ws_1",
        generation: 0,
      }, "p");
    } catch (err) {
      thrown = err as Error & { detail?: string };
    }
    // 只 throw 错误码（bridge 精确匹配依赖 message === "provider_session_busy"）。
    expect(thrown?.message).toBe("provider_session_busy");
    expect(thrown?.detail).toContain("正被 run r 使用");
  });

  it("normalizes production SSE fields into channel session events", async () => {
    const app = new Hono();
    app.get("/v1/sessions/:session/events", (c) => {
      expect(c.req.query("after_sequence")).toBe("3");
      expect(c.req.query("live")).toBe("true");
      return sse([
        '{"type":"ARTIFACT_CREATED","sequence":4,"run_id":"run_1","occurred_at":"2026-08-21T10:00:00.000Z","target":"artifact_1","result_ref":"artifact://artifact_1","payload":{"artifact_id":"artifact_1","step_id":"deploy","name":"deploy.output.json","mime_type":"application/json"}}',
        '{"type":"RUN_SUCCEEDED","sequence":5,"run_id":"run_1","occurred_at":"2026-08-21T10:00:01.000Z","target":null,"result_ref":null,"payload":{}}',
      ]);
    });
    const ingress = createChannelSessionIngress(app, "token");
    const events = [];
    for await (const event of ingress.events("sess_1", {
      afterSequence: 3,
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: "ARTIFACT_CREATED",
        sequence: 4,
        runId: "run_1",
        occurredAt: "2026-08-21T10:00:00.000Z",
        target: "artifact_1",
        resultRef: "artifact://artifact_1",
        payload: {
          artifact_id: "artifact_1",
          step_id: "deploy",
          name: "deploy.output.json",
          mime_type: "application/json",
        },
      },
      {
        type: "RUN_SUCCEEDED",
        sequence: 5,
        runId: "run_1",
        occurredAt: "2026-08-21T10:00:01.000Z",
        target: null,
        resultRef: null,
        payload: {},
      },
    ]);
  });

  it("replays a finite persisted event history without opening a live stream", async () => {
    const app = new Hono();
    app.get("/v1/sessions/:session/events", (c) => {
      expect(c.req.param("session")).toBe("sess_1");
      expect(c.req.query("after_sequence")).toBe("625");
      expect(c.req.query("live")).toBeUndefined();
      return sse([
        '{"type":"AGENT_EVENT","sequence":626,"run_id":"run_1","occurred_at":"2026-08-24T03:17:11.000Z","target":null,"result_ref":null,"payload":{"event":{"type":"text_delta","text":"final answer"}}}',
        '{"type":"RUN_SUCCEEDED","sequence":627,"run_id":"run_1","occurred_at":"2026-08-24T03:17:12.000Z","target":null,"result_ref":null,"payload":{}}',
      ]);
    });
    const ingress = createChannelSessionIngress(app, "token");

    const events = await ingress.replayEvents!("sess_1", {
      afterSequence: 625,
    });

    expect(events.map((event) => event.sequence)).toEqual([626, 627]);
    expect(events[0]).toMatchObject({
      type: "AGENT_EVENT",
      runId: "run_1",
      payload: { event: { type: "text_delta", text: "final answer" } },
    });
  });

  it("reports a finite event replay transport failure", async () => {
    const app = new Hono();
    app.get("/v1/sessions/:session/events", () =>
      new Response("unavailable", { status: 503 }),
    );
    const ingress = createChannelSessionIngress(app, "token");

    await expect(ingress.replayEvents!("sess_1", {
      afterSequence: 625,
    })).rejects.toThrow("Channel event replay failed (503)");
  });

  it("claims, acks and completes a delivery through the delivery routes", async () => {
    const app = new Hono();
    app.post("/v1/deliveries/:turn/claim", async (c) => {
      expect(c.req.param("turn")).toBe("turn_1");
      expect(await c.req.json()).toEqual({ owner: "owner-1" });
      return c.json({ claimed: true });
    });
    app.post("/v1/deliveries/:turn/ack", async (c) => {
      expect(await c.req.json()).toEqual({ owner: "owner-1", surface_message_id: "card-1" });
      return c.json({ acked: true });
    });
    app.post("/v1/deliveries/:turn/complete", async (c) => {
      expect(await c.req.json()).toEqual({ owner: "owner-1" });
      return c.json({ completed: true });
    });
    const ingress = createChannelSessionIngress(app, "token");
    expect(await ingress.claimDelivery("turn_1", "owner-1")).toBe(true);
    expect(await ingress.ackDelivery("turn_1", "owner-1", "card-1")).toBe(true);
    expect(await ingress.completeDelivery("turn_1", "owner-1")).toBe(true);
  });

  it("lists deliveries by channel", async () => {
    const app = new Hono();
    app.get("/v1/deliveries", (c) => {
      expect(c.req.query("channel")).toBe("feishu");
      return c.json({
        deliveries: [{
          turnId: "turn_1",
          status: "delivering",
          runSnapshot: {
            status: "succeeded",
            createdAt: "2026-08-21T00:00:00.000Z",
            updatedAt: "2026-08-21T00:00:05.000Z",
            leaseExpiresAt: null,
            terminalReason: null,
            sessionActiveRunId: null,
            sessionQueueState: "ready",
          },
        }],
      });
    });
    const ingress = createChannelSessionIngress(app, "token");
    const deliveries = await ingress.listDeliveries("feishu");
    expect(deliveries).toEqual([{
      turnId: "turn_1",
      status: "delivering",
      runSnapshot: {
        status: "succeeded",
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:05.000Z",
        leaseExpiresAt: null,
        terminalReason: null,
        sessionActiveRunId: null,
        sessionQueueState: "ready",
      },
    }]);
  });

  it("throws on a non-2xx delivery claim instead of returning false", async () => {
    const app = new Hono();
    app.post("/v1/deliveries/:turn/claim", () =>
      new Response("service unavailable", { status: 503 }),
    );
    const ingress = createChannelSessionIngress(app, "token");
    await expect(ingress.claimDelivery("turn_1", "owner-1")).rejects.toThrow(
      /claim delivery failed \(503\)/,
    );
  });
});
