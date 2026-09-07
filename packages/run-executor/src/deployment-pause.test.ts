import { expect, it } from "vitest";
import type { AgentEvent } from "@codebridge/core";
import { SqliteEventStore } from "@codebridge/work-items";
import { RunExecutor } from "./index.js";
it("drains active execution and leaves new runs queued until maintenance ends", async () => {
  const store = new SqliteEventStore(":memory:");
  const item = store.createWorkItem({ title: "edit", mode: "investigation", conversationId: "chat", workspaceScope: [], riskLevel: "read_only" });
  const first = store.createRun({ workItemId: item.id, mode: item.mode, executionKind: "agent" });
  const second = store.createRun({ workItemId: item.id, mode: item.mode, executionKind: "agent" });
  let paused = false;
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => { finish = resolve; });
  let started!: () => void;
  const admitted = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const executor = new RunExecutor(store, { async *run(): AsyncGenerator<AgentEvent> {
    calls++; started(); await barrier; yield { type: "done", exitCode: 0 };
  } }, {
    shouldPauseDispatch: () => paused,
    resolveRequest: (_item, run) => ({ runId: run.id, prompt: "edit", sessionKey: { chatId: "chat", backendId: "pi", cwd: "/tmp" } }),
  });
  const active = executor.execute(first.id);
  await admitted; paused = true;
  expect((await executor.execute(second.id)).status).toBe("queued");
  expect(calls).toBe(1);
  finish(); expect((await active).status).toBe("succeeded");
  expect(store.getRun(second.id)?.status).toBe("queued");
  paused = false;
  expect((await executor.execute(second.id)).status).toBe("succeeded");
  expect(calls).toBe(2); store.close();
});
