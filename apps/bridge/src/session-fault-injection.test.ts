import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCoordinator, SessionLeaseService, SessionRecoveryService } from "@codebridge/session-coordinator";

type Boundary =
  | "turn committed before claim"
  | "run claimed before provider response"
  | "text streaming"
  | "read-only tool completed"
  | "side-effect tool started"
  | "terminal committed before SSE publish"
  | "next Run committed before executor wakeup";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createFaultFixture(boundary: Boundary) {
  const directory = fs.mkdtempSync(
    path.join(process.cwd(), ".codebridge-session-fault-"),
  );
  tempDirs.push(directory);
  const databasePath = path.join(directory, "session.sqlite");
  const sessionId = "sess_1";
  let now = new Date("2026-08-14T00:00:00.000Z");
  let store = new SqliteEventStore(databasePath);
  let coordinator = new SessionCoordinator(store, {
    maxQueuedTurns: 100,
    now: () => now,
  });
  let leases = new SessionLeaseService(store, { now: () => now });
  let recovery = new SessionRecoveryService(
    store,
    coordinator,
    leases,
    () => now,
  );
  let sideEffectCalls = 0;
  let focusRunId: string | null = null;
  let focusTurnId: string | null = null;
  let workItemId = "";

  const submitted = coordinator.submitTurn({
    sessionId,
    idempotencyKey: "seed-1",
    message: {
      text: "检查 Session",
      attachmentIds: [],
      flowId: null,
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    },
    workItem: {
      title: "Session fault injection",
      mode: "auto",
      conversationId: "conv_fault",
      agentId: "pi",
      workspaceScope: ["/workspace"],
      riskLevel: "read_only",
    },
  });
  if (!submitted.run) {
    throw new Error("expected dispatched Run");
  }
  workItemId = submitted.workItemId;
  focusRunId = submitted.run.id;

  const claimAndExpire = () => {
    if (!focusRunId) throw new Error("expected a Run to claim");
    if (!leases.claim(focusRunId, "bridge:1")) {
      throw new Error("expected claim to succeed");
    }
    now = new Date("2026-08-14T00:01:01.000Z");
  };

  switch (boundary) {
    case "turn committed before claim":
      break;
    case "run claimed before provider response":
      claimAndExpire();
      break;
    case "text streaming":
      claimAndExpire();
      store.withSessionTransaction((tx) => tx.appendEvent({
        workItemId,
        sessionId,
        runId: focusRunId,
        type: "AGENT_EVENT",
        actor: "agent",
        payload: {
          event: {
            type: "text_delta",
            blockId: "answer_1",
            text: "streaming",
          },
        },
      }));
      break;
    case "read-only tool completed":
      claimAndExpire();
      store.withSessionTransaction((tx) => tx.appendEvent({
        workItemId,
        sessionId,
        runId: focusRunId,
        type: "AGENT_EVENT",
        actor: "agent",
        payload: {
          event: {
            type: "tool_result",
            tool_name: "read_only_lookup",
            output: "ok",
          },
        },
      }));
      break;
    case "side-effect tool started":
      claimAndExpire();
      sideEffectCalls += 1;
      store.updateRunControl(focusRunId, {
        replaySafety: "side_effect_started",
      });
      store.withSessionTransaction((tx) => tx.appendEvent({
        workItemId,
        sessionId,
        runId: focusRunId,
        type: "AGENT_EVENT",
        actor: "agent",
        payload: {
          event: {
            type: "tool_call",
            tool_name: "write_file",
            started: true,
          },
        },
      }));
      break;
    case "terminal committed before SSE publish":
      claimAndExpire();
      coordinator.finishRun({
        sessionId,
        runId: focusRunId,
        status: "succeeded",
        reason: "terminal-committed",
      });
      break;
    case "next Run committed before executor wakeup": {
      coordinator.finishRun({
        sessionId,
        runId: focusRunId,
        status: "succeeded",
        reason: "executor-wakeup-pending",
      });
      const queued = store.withSessionTransaction((tx) => {
        tx.ensureRuntime(sessionId);
        return tx.insertTurn(sessionId, {
          text: "下一次回合已落库",
          attachmentIds: [],
          flowId: null,
          model: null,
          effort: null,
          permissionMode: null,
          plan: null,
        });
      });
      focusRunId = null;
      focusTurnId = queued.turnId;
      break;
    }
  }

  function restart() {
    store.close();
    store = new SqliteEventStore(databasePath);
    coordinator = new SessionCoordinator(store, {
      maxQueuedTurns: 100,
      now: () => now,
    });
    leases = new SessionLeaseService(store, { now: () => now });
    recovery = new SessionRecoveryService(
      store,
      coordinator,
      leases,
      () => now,
    );
  }

  function activeOrLatestRun() {
    if (focusRunId) {
      const run = store.getRun(focusRunId);
      if (!run) throw new Error(`Run not found: ${focusRunId}`);
      return run;
    }
    if (focusTurnId) {
      const turn = store.getTurn(focusTurnId);
      if (!turn) throw new Error(`Turn not found: ${focusTurnId}`);
      return turn;
    }
    throw new Error("fixture lost its focus");
  }

  return {
    restart,
    recover: () => recovery.scanExpired(),
    activeOrLatestRun,
    get sideEffectCalls() {
      return sideEffectCalls;
    },
    close() {
      store.close();
    },
  };
}

describe("Session fault injection", () => {
  it.each([
    ["turn committed before claim", "queued"],
    ["run claimed before provider response", "interrupted"],
    ["text streaming", "interrupted"],
    ["read-only tool completed", "interrupted"],
    ["side-effect tool started", "interrupted"],
    ["terminal committed before SSE publish", "succeeded"],
    ["next Run committed before executor wakeup", "queued"],
  ] as const)("%s recovers to %s", (boundary, expected) => {
    const fixture = createFaultFixture(boundary);
    try {
      fixture.restart();
      fixture.recover();
      expect(fixture.activeOrLatestRun().status).toBe(expected);
      expect(fixture.sideEffectCalls).toBe(
        boundary === "side-effect tool started" ? 1 : 0,
      );
    } finally {
      fixture.close();
    }
  });
});
