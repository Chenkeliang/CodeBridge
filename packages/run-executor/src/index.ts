import type { AgentEvent, RunRequest } from "@codebridge/core";
import {
  SqliteEventStore,
  type Run,
  type WorkItem,
} from "@codebridge/work-items";

export interface RunnerStream {
  run(
    request: RunRequest,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<AgentEvent>;
}

export interface RunExecutorOptions {
  resolveRequest: (workItem: WorkItem, run: Run) => RunRequest | Promise<RunRequest>;
  onEvent?: (run: Run, event: AgentEvent) => void;
}

export class RunExecutor {
  constructor(
    private readonly store: SqliteEventStore,
    private readonly runner: RunnerStream,
    private readonly options: RunExecutorOptions,
  ) {}

  async execute(runId: string, signal?: AbortSignal): Promise<Run> {
    const initial = this.store.getRun(runId);
    if (!initial) throw new Error(`Run not found: ${runId}`);
    if (initial.status !== "queued") return initial;
    const workItem = this.store.getWorkItem(initial.workItemId);
    if (!workItem) throw new Error(`WorkItem not found: ${initial.workItemId}`);

    this.store.updateRunStatus(runId, "running");
    this.store.appendEvent({
      workItemId: workItem.id,
      runId,
      type: "RUN_STARTED",
      actor: "system",
      target: runId,
    });
    this.store.appendEvent({
      workItemId: workItem.id,
      runId,
      type: "STEP_STARTED",
      actor: "system",
      target: runId,
    });

    try {
      const request = await this.options.resolveRequest(workItem, initial);
      for await (const event of this.runner.run(request, { signal })) {
        this.options.onEvent?.(initial, event);
        this.store.appendEvent({
          workItemId: workItem.id,
          runId,
          type: "AGENT_EVENT",
          actor: "adapter",
          target: event.type,
          payload: { event },
        });
        if (event.type === "done" && event.exitCode !== 0) {
          throw new Error(`Runner exited with code ${event.exitCode}`);
        }
      }
      if (signal?.aborted) return this.cancel(runId, workItem.id);
      this.store.appendEvent({
        workItemId: workItem.id,
        runId,
        type: "STEP_SUCCEEDED",
        actor: "system",
        target: runId,
      });
      this.store.updateRunStatus(runId, "succeeded");
      this.store.appendEvent({
        workItemId: workItem.id,
        runId,
        type: "RUN_SUCCEEDED",
        actor: "system",
        target: runId,
      });
      this.store.appendEvent({
        workItemId: workItem.id,
        runId,
        type: "WORK_ITEM_COMPLETED",
        actor: "system",
        target: runId,
      });
      return this.store.getRun(runId)!;
    } catch (error) {
      if (signal?.aborted) return this.cancel(runId, workItem.id);
      this.store.updateRunStatus(runId, "failed");
      this.store.appendEvent({
        workItemId: workItem.id,
        runId,
        type: "STEP_FAILED",
        actor: "system",
        target: runId,
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      this.store.appendEvent({
        workItemId: workItem.id,
        runId,
        type: "RUN_FAILED",
        actor: "system",
        target: runId,
      });
      throw error;
    }
  }

  private cancel(runId: string, workItemId: string): Run {
    this.store.updateRunStatus(runId, "cancelled");
    this.store.appendEvent({
      workItemId,
      runId,
      type: "RUN_CANCELLED",
      actor: "system",
      target: runId,
    });
    return this.store.getRun(runId)!;
  }
}
