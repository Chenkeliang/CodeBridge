import type {
  Run,
  SessionRuntime,
  SessionRuntimeTransaction,
  SessionRuntimeWorkItemInput,
  SessionTurn,
  SessionTurnMessage,
  SqliteEventStore,
} from "@codebridge/work-items";

export class SessionCommandError extends Error {
  constructor(
    public readonly code:
      | "queue_full"
      | "turn_not_found"
      | "turn_not_queued"
      | "turn_version_conflict"
      | "runtime_version_conflict"
      | "active_run_mismatch",
    public readonly status: 404 | 409 | 422,
  ) {
    super(code);
  }
}

export interface SubmitTurnInput {
  sessionId: string;
  idempotencyKey: string;
  message: SessionTurnMessage;
  workItem: SessionRuntimeWorkItemInput;
}

export interface SubmitTurnResult {
  acceptance: "queued" | "dispatched";
  turn: SessionTurn;
  run: Run | null;
  runtime: SessionRuntime;
  workItemId: string;
}

export interface SessionCoordinatorOptions {
  maxQueuedTurns: number;
  now?: () => Date;
}

export class SessionCoordinator {
  protected readonly now: () => Date;

  constructor(
    protected readonly store: SqliteEventStore,
    protected readonly options: SessionCoordinatorOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  submitTurn(input: SubmitTurnInput): SubmitTurnResult {
    const namespace = `session:message:${input.sessionId}`;
    return this.store.withSessionTransaction((tx) => {
      const prior = tx.getIdempotencyResponse<SubmitTurnResult>(
        namespace,
        input.idempotencyKey,
      );
      if (prior) return prior;

      const workItemId = tx.getOrCreateWorkItem(
        input.sessionId,
        input.workItem,
      );
      let runtime = tx.ensureRuntime(input.sessionId);
      if (
        tx.countQueuedTurns(input.sessionId)
        >= this.options.maxQueuedTurns
      ) {
        throw new SessionCommandError("queue_full", 422);
      }

      const submitted = tx.insertTurn(input.sessionId, input.message);
      let turn = submitted;
      let run: Run | null = null;
      if (
        runtime.activeRunId === null
        && runtime.queueState === "ready"
      ) {
        const dispatched = tx.dispatchNextTurn(input.sessionId)!;
        turn = dispatched.turn.turnId === submitted.turnId
          ? dispatched.turn
          : submitted;
        run = dispatched.run;
      }

      if (turn.status === "queued") {
        tx.appendEvent({
          workItemId,
          sessionId: input.sessionId,
          type: "TURN_QUEUED",
          actor: "user",
          target: turn.turnId,
          payload: { queue_position: turn.queuePosition },
        });
      }
      runtime = tx.getRuntime(input.sessionId)!;
      const result: SubmitTurnResult = {
        acceptance: turn.status === "dispatched"
          ? "dispatched"
          : "queued",
        turn,
        run,
        runtime,
        workItemId,
      };
      tx.putIdempotencyResponse(
        namespace,
        input.idempotencyKey,
        result,
      );
      return result;
    });
  }

  finishRun(input: {
    sessionId: string;
    runId: string;
    status: "succeeded" | "failed" | "cancelled" | "interrupted";
    reason?: string;
  }): {
    runtime: SessionRuntime;
    run: Run;
    dispatched: { turn: SessionTurn; run: Run } | null;
  } {
    return this.store.withSessionTransaction((tx) =>
      this.finishRunInTransaction(tx, input)
    );
  }

  cancelQueuedTurn(input: {
    sessionId: string;
    turnId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }): { turn: SessionTurn; runtime: SessionRuntime } {
    const namespace =
      `session:queue-cancel:${input.sessionId}:${input.turnId}`;
    return this.store.withSessionTransaction((tx) => {
      const prior = tx.getIdempotencyResponse<{
        turn: SessionTurn;
        runtime: SessionRuntime;
      }>(namespace, input.idempotencyKey);
      if (prior) return prior;

      const current = tx.getTurn(input.turnId);
      if (!current || current.sessionId !== input.sessionId) {
        throw new SessionCommandError("turn_not_found", 404);
      }
      if (current.status !== "queued") {
        throw new SessionCommandError("turn_not_queued", 409);
      }
      if (current.version !== input.expectedVersion) {
        throw new SessionCommandError("turn_version_conflict", 409);
      }
      const turn = tx.cancelTurn(
        input.turnId,
        input.expectedVersion,
      );
      if (!turn) {
        throw new SessionCommandError("turn_version_conflict", 409);
      }
      const workItem = tx.getWorkItemForSession(input.sessionId);
      if (!workItem) {
        throw new SessionCommandError("turn_not_found", 404);
      }
      tx.appendEvent({
        workItemId: workItem.id,
        sessionId: input.sessionId,
        type: "TURN_CANCELLED",
        actor: "user",
        target: turn.turnId,
        payload: { queue_position: turn.queuePosition },
      });
      const result = {
        turn,
        runtime: tx.getRuntime(input.sessionId)!,
      };
      tx.putIdempotencyResponse(
        namespace,
        input.idempotencyKey,
        result,
      );
      return result;
    });
  }

  resumeQueue(input: {
    sessionId: string;
    expectedRuntimeVersion: number;
    idempotencyKey: string;
  }): {
    runtime: SessionRuntime;
    dispatched: { turn: SessionTurn; run: Run } | null;
  } {
    const namespace = `session:queue-resume:${input.sessionId}`;
    return this.store.withSessionTransaction((tx) => {
      const prior = tx.getIdempotencyResponse<{
        runtime: SessionRuntime;
        dispatched: { turn: SessionTurn; run: Run } | null;
      }>(namespace, input.idempotencyKey);
      if (prior) return prior;
      const runtime = tx.ensureRuntime(input.sessionId);
      if (runtime.version !== input.expectedRuntimeVersion) {
        throw new SessionCommandError(
          "runtime_version_conflict",
          409,
        );
      }
      tx.updateRuntime(input.sessionId, {
        queueState: "ready",
        queuePauseReason: null,
      });
      const dispatched = tx.dispatchNextTurn(input.sessionId);
      const result = {
        runtime: tx.getRuntime(input.sessionId)!,
        dispatched,
      };
      tx.putIdempotencyResponse(
        namespace,
        input.idempotencyKey,
        result,
      );
      return result;
    });
  }

  protected finishRunInTransaction(
    tx: SessionRuntimeTransaction,
    input: {
      sessionId: string;
      runId: string;
      status: "succeeded" | "failed" | "cancelled" | "interrupted";
      reason?: string;
    },
  ): {
    runtime: SessionRuntime;
    run: Run;
    dispatched: { turn: SessionTurn; run: Run } | null;
  } {
    const runtime = tx.ensureRuntime(input.sessionId);
    if (runtime.activeRunId !== input.runId) {
      throw new SessionCommandError("active_run_mismatch", 409);
    }
    const existingRun = tx.getRun(input.runId);
    if (!existingRun || existingRun.sessionId !== input.sessionId) {
      throw new SessionCommandError("active_run_mismatch", 409);
    }
    const run = tx.updateRun(input.runId, {
      status: input.status,
      terminalReason: input.reason ?? null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const eventType = {
      succeeded: "RUN_SUCCEEDED",
      failed: "RUN_FAILED",
      cancelled: "RUN_CANCELLED",
      interrupted: "RUN_INTERRUPTED",
    } as const;
    tx.appendEvent({
      workItemId: run.workItemId,
      sessionId: input.sessionId,
      runId: run.id,
      type: eventType[input.status],
      actor: "system",
      payload: input.reason ? { reason: input.reason } : {},
    });

    let dispatched: { turn: SessionTurn; run: Run } | null = null;
    if (input.status === "succeeded") {
      tx.updateRuntime(input.sessionId, {
        activeRunId: null,
        queueState: "ready",
        queuePauseReason: null,
      });
      dispatched = tx.dispatchNextTurn(input.sessionId);
    } else {
      tx.updateRuntime(input.sessionId, {
        activeRunId: null,
        queueState: "paused",
        queuePauseReason: input.status,
      });
    }
    return {
      runtime: tx.getRuntime(input.sessionId)!,
      run,
      dispatched,
    };
  }
}
