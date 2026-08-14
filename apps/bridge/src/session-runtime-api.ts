import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SessionCatalogStore } from "@codebridge/session-catalog";
import type { SqliteEventStore } from "@codebridge/work-items";
import {
  toApiRun,
  toApiSession,
  toApiSessionTurn,
  toApiTimeline,
} from "./session-runtime-types.js";

export interface SessionRuntimeApiOptions {
  catalog: SessionCatalogStore;
  workItems: SqliteEventStore;
}

export function registerSessionRuntimeReadRoutes(
  app: Hono,
  options: SessionRuntimeApiOptions,
): void {
  app.get("/v1/sessions/:session_id", (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const runtime = options.workItems.getSessionRuntime(session.id);
    const activeRun = runtime?.activeRunId
      ? options.workItems.getRun(runtime.activeRunId)
      : undefined;
    const queue = options.workItems.listQueuedTurns(session.id, {
      limit: 100,
    });
    const timeline = options.workItems.listTimelineTurns(session.id, {
      limit: 50,
      contentBudgetBytes: 1_048_576,
    });
    const workItem =
      options.workItems.getWorkItemBySessionId(session.id);
    return c.json({
      session: toApiSession({
        ...session,
        taskRecordId: session.taskRecordId ?? workItem?.id ?? null,
      }),
      runtime: {
        active_run: activeRun ? toApiRun(activeRun, session.id) : null,
        queue_state: runtime?.queueState ?? "ready",
        queue_pause_reason: runtime?.queuePauseReason ?? null,
        queue: {
          turns: queue.turns.map(toApiSessionTurn),
          total: queue.total,
          next_cursor: queue.nextCursor,
        },
        version: runtime?.version ?? 1,
        last_event_sequence: runtime?.lastEventSequence ?? 0,
      },
      timeline: toApiTimeline(timeline),
      commands: options.workItems.listSessionCommands(session.id),
    });
  });

  app.get("/v1/sessions/:session_id/timeline", (c) => {
    if (!options.catalog.getSession(c.req.param("session_id"))) {
      return c.json({ error: "session_not_found" }, 404);
    }
    return c.json(toApiTimeline(options.workItems.listTimelineTurns(
      c.req.param("session_id"),
      {
        before: integerQuery(c.req.query("before")),
        limit: integerQuery(c.req.query("limit")) ?? 50,
        contentBudgetBytes: 1_048_576,
      },
    )));
  });

  app.get(
    "/v1/sessions/:session_id/blocks/:block_id/segments",
    (c) => {
      if (!options.catalog.getSession(c.req.param("session_id"))) {
        return c.json({ error: "session_not_found" }, 404);
      }
      const page = options.workItems.listTimelineSegments(
        c.req.param("block_id"),
        {
          after: integerQuery(c.req.query("after")),
          limit: integerQuery(c.req.query("limit")) ?? 100,
        },
      );
      return c.json({
        segments: page.segments.map((segment) => ({
          segment_id: segment.segmentId,
          segment_index: segment.segmentIndex,
          content: segment.content,
          byte_length: segment.byteLength,
          sealed: segment.sealed,
        })),
        next_cursor: page.nextCursor,
      });
    },
  );

  app.get("/v1/sessions/:session_id/queue", (c) => {
    if (!options.catalog.getSession(c.req.param("session_id"))) {
      return c.json({ error: "session_not_found" }, 404);
    }
    const page = options.workItems.listQueuedTurns(
      c.req.param("session_id"),
      {
        afterPosition:
          integerQuery(c.req.query("after_position")),
        limit: integerQuery(c.req.query("limit")) ?? 100,
      },
    );
    return c.json({
      turns: page.turns.map(toApiSessionTurn),
      total: page.total,
      next_cursor: page.nextCursor,
    });
  });

  app.get("/v1/sessions/:session_id/commands", (c) => {
    if (!options.catalog.getSession(c.req.param("session_id"))) {
      return c.json({ error: "session_not_found" }, 404);
    }
    return c.json({
      commands: options.workItems.listSessionCommands(
        c.req.param("session_id"),
      ),
    });
  });

  app.get("/v1/sessions/:session_id/events", (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    let workItem = options.workItems.getWorkItemBySessionId(session.id)
      ?? (session.taskRecordId
        ? options.workItems.getWorkItem(session.taskRecordId)
        : undefined);
    const after = integerQuery(c.req.query("after_sequence")) ?? 0;
    if (c.req.query("live") === "true") {
      return streamSSE(c, async (stream) => {
        let cursor = after;
        let aborted = false;
        stream.onAbort(() => { aborted = true; });
        while (!aborted) {
          workItem ??= options.workItems.getWorkItemBySessionId(session.id)
            ?? (options.catalog.getSession(session.id)?.taskRecordId
              ? options.workItems.getWorkItem(
                  options.catalog.getSession(session.id)!.taskRecordId!,
                )
              : undefined);
          const candidates = workItem
            ? options.workItems.listEventsPage(
                workItem.id,
                cursor,
                500,
              )
            : [];
          let bytes = 0;
          let wrote = false;
          for (const event of candidates) {
            const data = JSON.stringify(event);
            const size = Buffer.byteLength(data, "utf8");
            if (wrote && bytes + size > 1_048_576) break;
            await stream.writeSSE({
              id: String(event.sequence),
              event: "session_event",
              data,
            });
            cursor = event.sequence;
            bytes += size;
            wrote = true;
          }
          if (!wrote) await stream.sleep(250);
        }
      });
    }
    if (!workItem) {
      return c.json({
        events: [],
        next_sequence: after,
        has_more: false,
      });
    }
    const tail = integerQuery(c.req.query("tail"));
    if (tail !== undefined) {
      const events = options.workItems.listRecentEvents(
        workItem.id,
        Math.min(500, Math.max(1, tail)),
      );
      return c.json({
        events,
        next_sequence: events.at(-1)?.sequence ?? after,
        has_more: false,
      });
    }
    {
      const requested = integerQuery(c.req.query("limit")) ?? 500;
      const limit = Math.min(500, Math.max(1, requested));
      const rows = options.workItems.listEventsPage(
        workItem.id,
        after,
        limit + 1,
      );
      const events = rows.slice(0, limit);
      return c.json({
        events,
        next_sequence: events.at(-1)?.sequence ?? after,
        has_more: rows.length > events.length,
      });
    }
  });
}

function integerQuery(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined;
  return Number(value);
}
