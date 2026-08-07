import { describe, expect, it } from "vitest";
import type { AgentEvent, RunRequest } from "@codebridge/core";
import { SqliteEventStore } from "@codebridge/work-items";
import { RunExecutor } from "./index.js";

class FakeRunner {
  constructor(private readonly events: AgentEvent[], private readonly fail = false) {}

  async *run(_request: RunRequest): AsyncGenerator<AgentEvent> {
    for (const event of this.events) yield event;
    if (this.fail) throw new Error("runner offline");
  }
}

function setup() {
  const store = new SqliteEventStore(":memory:");
  const item = store.createWorkItem({
    title: "Investigate",
    mode: "investigation",
    conversationId: "web:conversation",
    agentId: "pi-investigator",
    workspaceScope: ["/tmp/project"],
    riskLevel: "read_only",
  });
  const run = store.createRun({ workItemId: item.id, mode: item.mode });
  return { store, item, run };
}

describe("RunExecutor", () => {
  it("executes a queued run and persists Agent events and terminal state", async () => {
    const { store, item, run } = setup();
    const runner = new FakeRunner([
      { type: "text_delta", text: "调查结果" },
      { type: "done", exitCode: 0 },
    ]);
    const executor = new RunExecutor(store, runner, {
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: {
          chatId: item.conversationId,
          backendId: "pi",
          cwd: "/tmp/project",
        },
        prompt: "调查",
      }),
    });

    const result = await executor.execute(run.id);
    expect(result.status).toBe("succeeded");
    expect(store.getRun(run.id)?.status).toBe("succeeded");
    expect(store.getWorkItem(item.id)?.status).toBe("completed");
    expect(store.listEvents(item.id).map((event) => event.type)).toEqual([
      "WORK_ITEM_CREATED",
      "RUN_CREATED",
      "RUN_STARTED",
      "STEP_STARTED",
      "AGENT_EVENT",
      "AGENT_EVENT",
      "STEP_SUCCEEDED",
      "RUN_SUCCEEDED",
      "WORK_ITEM_COMPLETED",
    ]);
    store.close();
  });

  it("marks a run failed when the Runner stream errors", async () => {
    const { store, item, run } = setup();
    const executor = new RunExecutor(store, new FakeRunner([], true), {
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: "调查",
      }),
    });

    await expect(executor.execute(run.id)).rejects.toThrow("runner offline");
    expect(store.getRun(run.id)?.status).toBe("failed");
    expect(store.getWorkItem(item.id)?.status).toBe("failed");
    store.close();
  });
});
