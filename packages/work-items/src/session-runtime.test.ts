import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "./index.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-session-runtime-"));
  directories.push(directory);
  return path.join(directory, "orchestration.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Session runtime schema", () => {
  it("links one WorkItem to one Session and persists runtime state", () => {
    const store = new SqliteEventStore(databasePath());
    const item = store.createWorkItem({
      title: "Session",
      mode: "auto",
      conversationId: "conv_session_1",
      sessionId: "sess_1",
      agentId: "pi",
      riskLevel: "read_only",
    });

    expect(store.getWorkItemBySessionId("sess_1")).toEqual(item);
    expect(store.getSessionRuntime("sess_1")).toMatchObject({
      sessionId: "sess_1",
      activeRunId: null,
      queueState: "ready",
      version: 1,
      lastEventSequence: 1,
    });
    store.close();
  });

  it("rejects a second active Run for one Session", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "Session",
      mode: "auto",
      conversationId: "conv_session_1",
      sessionId: "sess_1",
      riskLevel: "read_only",
    });
    store.createRun({
      id: "run_1",
      workItemId: item.id,
      sessionId: "sess_1",
      mode: "auto",
    });
    expect(() => store.createRun({
      id: "run_2",
      workItemId: item.id,
      sessionId: "sess_1",
      mode: "auto",
    })).toThrow();
    store.close();
  });

  it("persists interrupted and lease metadata", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "Session",
      mode: "auto",
      conversationId: "conv_session_1",
      sessionId: "sess_1",
      riskLevel: "read_only",
    });
    const run = store.createRun({
      workItemId: item.id,
      sessionId: "sess_1",
      turnId: "turn_1",
      mode: "auto",
    });
    store.updateRunControl(run.id, {
      status: "interrupted",
      terminalReason: "lease_expired",
      replaySafety: "outcome_unknown",
    });

    expect(store.getRun(run.id)).toMatchObject({
      sessionId: "sess_1",
      turnId: "turn_1",
      status: "interrupted",
      terminalReason: "lease_expired",
      replaySafety: "outcome_unknown",
    });
    store.close();
  });
});
