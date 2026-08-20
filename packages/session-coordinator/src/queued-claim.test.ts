import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCoordinator } from "./coordinator.js";
import {
  QUEUED_RUN_FRESHNESS_MS,
  classifyQueuedRun,
  reclaimQueuedRuns,
} from "./queued-claim.js";

describe("classifyQueuedRun", () => {
  const run = {
    status: "queued" as const,
    sessionId: "sess_1",
    createdAt: "2026-08-20T00:00:00.000Z",
  };

  it("executes a fresh never-started session run", () => {
    expect(classifyQueuedRun({
      run: { ...run, id: "run_1", workItemId: "wi" } as never,
      runtime: { queueState: "ready" } as never,
      nowMs: Date.parse("2026-08-20T00:01:00.000Z"),
      hasStarted: false,
    })).toBe("execute");
  });

  it("marks an old never-started session run stale", () => {
    expect(classifyQueuedRun({
      run: { ...run, id: "run_1", workItemId: "wi" } as never,
      runtime: { queueState: "ready" } as never,
      nowMs: Date.parse("2026-08-20T00:00:00.000Z") + QUEUED_RUN_FRESHNESS_MS + 1,
      hasStarted: false,
    })).toBe("stale");
  });

  it("skips paused queues and already-started runs", () => {
    expect(classifyQueuedRun({
      run: { ...run, id: "run_1", workItemId: "wi" } as never,
      runtime: { queueState: "paused" } as never,
      nowMs: Date.parse("2026-08-20T00:01:00.000Z"),
      hasStarted: false,
    })).toBe("skip");
    expect(classifyQueuedRun({
      run: { ...run, id: "run_1", workItemId: "wi" } as never,
      runtime: { queueState: "ready" } as never,
      nowMs: Date.parse("2026-08-20T00:01:00.000Z"),
      hasStarted: true,
    })).toBe("skip");
  });
});

describe("reclaimQueuedRuns", () => {
  it("pauses stale session runs and executes fresh ones", () => {
    const store = new SqliteEventStore(":memory:");
    const coordinator = new SessionCoordinator(store, {
      maxQueuedTurns: 100,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const submitted = coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "message_1",
      message: {
        text: "卡住了？",
        attachmentIds: [],
        flowId: null,
        model: null,
        effort: null,
        permissionMode: null,
        plan: null,
      },
      workItem: {
        title: "Session",
        mode: "auto",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only",
      },
    });
    const executed: string[] = [];
    const created = Date.parse(submitted.run!.createdAt);
    const result = reclaimQueuedRuns({
      store,
      coordinator,
      execute: (runId) => executed.push(runId),
      now: () => new Date(created + QUEUED_RUN_FRESHNESS_MS + 1),
    });
    expect(result.paused).toEqual([submitted.run!.id]);
    expect(executed).toEqual([]);
    expect(store.getSessionRuntime("sess_1")?.queuePauseReason).toBe("stale");
    store.close();
  });
});
