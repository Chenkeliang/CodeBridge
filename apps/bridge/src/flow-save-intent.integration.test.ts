import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore } from "@codebridge/work-items";
import { candidateFlowId, FlowSaveIntentService } from "./flow-save-intent.js";

const temporaryDirectories: string[] = [];
const openStores: Array<{
  sessions: SessionCatalogStore;
  events: SqliteEventStore;
  catalog: FlowCatalogStore;
}> = [];

afterEach(() => {
  for (const stores of openStores.splice(0)) {
    stores.catalog.close();
    stores.events.close();
    stores.sessions.close();
  }
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function databasePaths(): { directory: string; sessions: string; events: string; catalog: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-flow-save-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    sessions: path.join(directory, "sessions.sqlite"),
    events: path.join(directory, "events.sqlite"),
    catalog: path.join(directory, "flows.sqlite"),
  };
}

function seedPersistentRequest(paths: ReturnType<typeof databasePaths>) {
  const sessions = new SessionCatalogStore(paths.sessions);
  const events = new SqliteEventStore(paths.events);
  const catalog = new FlowCatalogStore(paths.catalog);
  const session = sessions.createSession({ id: "sess_crash", agentId: "codex", taskRecordId: "wi_crash" });
  const item = events.createWorkItem({
    id: "wi_crash",
    title: "持久化来源",
    mode: "auto",
    conversationId: `conv_${session.id}`,
    sessionId: session.id,
    agentId: "codex",
    riskLevel: "read_only",
  });
  events.withSessionTransaction((transaction) => {
    transaction.ensureRuntime(session.id);
    const turn = transaction.insertTurn(session.id, {
      text: "查询并核对订单",
      attachmentIds: [],
      flowId: null,
      executionKind: "agent",
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    });
    transaction.dispatchTurn(turn.turnId, {
      id: "run_crash_source",
      workItemId: item.id,
      sessionId: session.id,
      turnId: turn.turnId,
      agentId: "codex",
      mode: "auto",
      executionKind: "agent",
      planId: null,
      planIrHash: null,
      workflowRevision: null,
    });
  });
  for (const [index, name] of ["Read File", "Search"].entries()) {
    events.appendEvent({
      workItemId: item.id,
      runId: "run_crash_source",
      type: "AGENT_EVENT",
      actor: "adapter",
      payload: { event: { type: "tool_start", toolCallId: `tool_${index}`, name } },
    });
  }
  events.updateRunStatus("run_crash_source", "succeeded");
  events.appendEvent({
    workItemId: item.id,
    runId: "run_crash_source",
    type: "RUN_SUCCEEDED",
    actor: "system",
    target: "run_crash_source",
  });
  const service = new FlowSaveIntentService({ sessions, events, catalog });
  const request = service.requestManual({
    sessionId: session.id,
    sourceRunId: "run_crash_source",
  }, "manual-key");
  const fixture = { sessions, events, catalog, service, request };
  openStores.push(fixture);
  return fixture;
}

describe("Flow save intent startup reconciliation", () => {
  it("repairs only the missing terminal event after a Catalog-save crash window", async () => {
    const paths = databasePaths();
    const first = seedPersistentRequest(paths);
    const originalAppend = first.events.appendEventOnce.bind(first.events);
    vi.spyOn(first.events, "appendEventOnce").mockImplementation((input) => {
      if (input.type === "FLOW_CANDIDATE_CREATED") throw new Error("injected_event_failure");
      return originalAppend(input);
    });

    await expect(first.service.confirm(first.request.requestId, "confirm-key"))
      .rejects.toThrow("injected_event_failure");
    expect(first.catalog.get(candidateFlowId(first.request.requestId))?.status).toBe("candidate");
    first.catalog.close();
    first.events.close();
    first.sessions.close();

    const sessions = new SessionCatalogStore(paths.sessions);
    const events = new SqliteEventStore(paths.events);
    const catalog = new FlowCatalogStore(paths.catalog);
    openStores.push({ sessions, events, catalog });
    const recovered = new FlowSaveIntentService({ sessions, events, catalog });
    expect(await recovered.reconcilePendingAtStartup()).toBe(1);
    expect(recovered.getRequestState(first.request.requestId).state).toBe("completed");
    expect(events.listEventsByTarget(first.request.requestId)
      .filter((entry) => entry.type === "FLOW_CANDIDATE_CREATED")).toHaveLength(1);
    expect(await recovered.reconcilePendingAtStartup()).toBe(0);

  });

  it("never completes a pending request from a colliding deterministic ID", async () => {
    const paths = databasePaths();
    const fixture = seedPersistentRequest(paths);
    fixture.catalog.save({
      flowId: candidateFlowId(fixture.request.requestId),
      name: "Collision",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:collision",
      steps: [{ id: "collision", purpose: "不得覆盖" }],
      provenance: {
        sourceRunId: "run_other",
        sourceSessionId: fixture.request.sessionId,
        sourceFlowId: "flow_other",
        sourceDefinitionRevision: "sha256:other",
        sourceRequestId: fixture.request.requestId,
      },
    });

    expect(await fixture.service.reconcilePendingAtStartup()).toBe(1);
    expect(fixture.service.getRequestState(fixture.request.requestId).state).toBe("failed");
    expect(fixture.events.listEventsByTarget(fixture.request.requestId)
      .some((entry) => entry.type === "FLOW_CANDIDATE_CREATED")).toBe(false);

  });

  it.each(["published", "deprecated"] as const)(
    "repairs a pending request from a matching deterministic %s record",
    async (status) => {
    const paths = databasePaths();
    const fixture = seedPersistentRequest(paths);
    fixture.catalog.save({
      flowId: candidateFlowId(fixture.request.requestId),
      name: `Already ${status}`,
      kind: "runbook",
      status,
      source: "agent_generated",
      definitionRevision: `sha256:${status}`,
      reviewStatus: "approved",
      gitRevision: `git:${status}`,
      steps: [{ id: status, purpose: "补齐已保存的终态事件" }],
      provenance: {
        sourceRunId: fixture.request.sourceRunId,
        sourceSessionId: fixture.request.sessionId,
        sourceFlowId: "flow_ephemeral_run_crash_source",
        sourceDefinitionRevision: "sha256:source",
        sourceRequestId: fixture.request.requestId,
      },
    });

    expect(await fixture.service.reconcilePendingAtStartup()).toBe(1);
    expect(fixture.service.getRequestState(fixture.request.requestId)).toMatchObject({
      state: "completed",
      flowId: candidateFlowId(fixture.request.requestId),
    });
    expect(fixture.events.listEventsByTarget(fixture.request.requestId)
      .filter((entry) => entry.type === "FLOW_CANDIDATE_CREATED")).toHaveLength(1);
    expect(fixture.events.listEventsByTarget(fixture.request.requestId)
      .filter((entry) => entry.type === "FLOW_SAVE_FAILED")).toHaveLength(0);
    },
  );
});
