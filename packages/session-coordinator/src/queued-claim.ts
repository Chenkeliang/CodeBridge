import type {
  Run,
  SessionRuntime,
  SqliteEventStore,
} from "@codebridge/work-items";
import type { SessionCoordinator } from "./coordinator.js";

/** 从未启动的 queued Run，超过此时长不再自动领取，改为暂停等人 `/c`。 */
export const QUEUED_RUN_FRESHNESS_MS = 15 * 60_000;

export function classifyQueuedRun(input: {
  run: Run;
  runtime: SessionRuntime | undefined;
  nowMs: number;
  hasStarted: boolean;
}): "execute" | "stale" | "skip" {
  if (input.run.status !== "queued") return "skip";
  if (input.hasStarted) return "skip";
  if (!input.run.sessionId) return "execute";
  if (input.runtime?.queueState === "paused") return "skip";
  const createdMs = Date.parse(input.run.createdAt);
  if (!Number.isFinite(createdMs) || input.nowMs - createdMs > QUEUED_RUN_FRESHNESS_MS) {
    return "stale";
  }
  return "execute";
}

export function reclaimQueuedRuns(input: {
  store: SqliteEventStore;
  coordinator: SessionCoordinator;
  execute: (runId: string) => void;
  now?: () => Date;
}): { executed: string[]; paused: string[] } {
  const nowMs = (input.now ?? (() => new Date()))().getTime();
  const executed: string[] = [];
  const paused: string[] = [];
  for (const run of input.store.listRunsByStatus(["queued"])) {
    const runtime = run.sessionId
      ? input.store.getSessionRuntime(run.sessionId)
      : undefined;
    const hasStarted = input.store
      .listEvents(run.workItemId)
      .some((event) => event.runId === run.id && event.type === "RUN_STARTED");
    const action = classifyQueuedRun({ run, runtime, nowMs, hasStarted });
    if (action === "stale" && run.sessionId) {
      input.coordinator.pauseQueue({
        sessionId: run.sessionId,
        reason: "stale",
      });
      paused.push(run.id);
      continue;
    }
    if (action === "execute") {
      input.execute(run.id);
      executed.push(run.id);
    }
  }
  return { executed, paused };
}
