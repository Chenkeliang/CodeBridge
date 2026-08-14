import { randomUUID } from "node:crypto";
import type {
  Run,
  SessionRuntime,
  SessionRuntimeWorkItemInput,
  SessionTurn,
  SessionTurnMessage,
  SqliteEventStore,
} from "@codebridge/work-items";

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
        throw new Error("queue_full");
      }

      const submitted = tx.insertTurn(input.sessionId, input.message);
      let turn = submitted;
      let run: Run | null = null;
      if (
        runtime.activeRunId === null
        && runtime.queueState === "ready"
      ) {
        const head = tx.nextQueuedTurn(input.sessionId)!;
        const runId = `run_${randomUUID().replaceAll("-", "")}`;
        const dispatched = tx.dispatchTurn(head.turnId, {
          id: runId,
          workItemId,
          sessionId: input.sessionId,
          turnId: head.turnId,
          mode: input.workItem.mode,
          agentId: input.workItem.agentId,
          planId: head.message.plan?.planId ?? null,
          planIrHash: head.message.plan?.planIrHash ?? null,
          workflowRevision:
            head.message.plan?.definitionRevision ?? null,
        });
        turn = head.turnId === submitted.turnId
          ? dispatched.turn
          : submitted;
        run = dispatched.run;
        runtime = tx.updateRuntime(input.sessionId, {
          activeRunId: run.id,
        });
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
}
