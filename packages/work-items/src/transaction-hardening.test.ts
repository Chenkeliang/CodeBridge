import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "./index.js";
import {
  createSqliteSessionRuntimeTransaction,
  type SessionRuntimeTransaction,
} from "./session-runtime.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

describe("session transaction hardening", () => {
  it("rejects nested transactions", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "nested",
      mode: "auto",
      conversationId: "conv_nested",
      riskLevel: "read_only",
    });
    expect(() => {
      store.withSessionTransaction(() => {
        store.appendEvent({
          workItemId: item.id,
          type: "RUN_CREATED",
          actor: "system",
          target: "run_1",
        });
      });
    }).toThrow(/nested transaction/i);
    store.close();
  });

  it("resets transaction depth after a thrown operation", () => {
    const store = new SqliteEventStore(":memory:");
    expect(() =>
      store.withSessionTransaction(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(() => store.withSessionTransaction(() => {})).not.toThrow();
    store.close();
  });

  it("rejects facade writes after its transaction ends", () => {
    const store = new SqliteEventStore(":memory:");
    let captured: SessionRuntimeTransaction | undefined;
    store.withSessionTransaction((tx) => {
      captured = tx;
    });
    expect(() => captured!.ensureRuntime("sess_stale")).toThrow(
      /active transaction/i,
    );
    store.close();
  });

  it("rejects facade writes when the database has no transaction", () => {
    const db = new DatabaseSync(":memory:");
    const { transaction } = createSqliteSessionRuntimeTransaction(db);
    expect(() => transaction.ensureRuntime("sess_1")).toThrow(
      /active transaction/i,
    );
    db.close();
  });

  it("does not leak transaction state across stores", () => {
    const a = new SqliteEventStore(":memory:");
    const b = new SqliteEventStore(":memory:");
    let txA: SessionRuntimeTransaction | undefined;
    a.withSessionTransaction((tx) => {
      txA = tx;
    });
    b.withSessionTransaction((tx) => {
      expect(() => tx.ensureRuntime("sess_b")).not.toThrow();
    });
    expect(() => txA!.ensureRuntime("sess_a")).toThrow(
      /active transaction/i,
    );
    a.close();
    b.close();
  });
});
