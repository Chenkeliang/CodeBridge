import { describe, expect, it, vi } from "vitest";
import type {
  ChannelSessionEvent,
  ChannelSessionIngress,
} from "@codebridge/core";
import {
  TelegramSessionWatcher,
  type PendingTurn,
} from "./telegram-session-watcher.js";

function makeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 8 }),
    editMessage: vi.fn().mockResolvedValue({ message_id: 8 }),
  };
}

function makeIngress() {
  return {
    events: vi.fn(async function* () {
      await new Promise(() => {});
    }),
    claimDelivery: vi.fn(async () => true),
    ackDelivery: vi.fn(async () => true),
    completeDelivery: vi.fn(async () => true),
    listDeliveries: vi.fn(async () => []),
  };
}

type Ingress = ReturnType<typeof makeIngress>;
type Api = ReturnType<typeof makeApi>;

function watcher(ingress: Ingress, api: Api, onLog: (message: string) => void = () => {}) {
  return new TelegramSessionWatcher(
    api,
    ingress as unknown as ChannelSessionIngress,
    "sess_1",
    "inst-1",
    onLog,
  );
}

function turn(turnId = "turn_1"): PendingTurn {
  return {
    turnId,
    chatId: "telegram:42",
    topicId: undefined,
    showThinking: false,
  };
}

function terminalEvent(
  sequence: number,
  type: "RUN_SUCCEEDED" | "RUN_FAILED" | "RUN_CANCELLED" | "RUN_INTERRUPTED" = "RUN_SUCCEEDED",
): ChannelSessionEvent {
  return {
    type,
    sequence,
    runId: "run_1",
    occurredAt: `2026-08-21T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    target: null,
    resultRef: null,
    payload: {},
  };
}

function agentEvent(
  sequence: number,
  event: Record<string, unknown>,
): ChannelSessionEvent {
  return {
    type: "AGENT_EVENT",
    sequence,
    runId: "run_1",
    occurredAt: `2026-08-21T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    target: null,
    resultRef: null,
    payload: { event },
  };
}

function flowEvent(
  sequence: number,
  type: string,
  target: string | null,
  payload: Record<string, unknown> = {},
  resultRef: string | null = null,
): ChannelSessionEvent {
  return {
    type,
    sequence,
    runId: "run_1",
    occurredAt: `2026-08-21T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    target,
    resultRef,
    payload,
  };
}

function blockingEvents(events: ChannelSessionEvent[]) {
  return vi.fn(async function* (
    _sessionId: string,
    opts: { afterSequence: number; signal: AbortSignal },
  ) {
    for (const event of events) yield event;
    await new Promise<void>((resolve) =>
      opts.signal?.addEventListener("abort", () => resolve()),
    );
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("TelegramSessionWatcher", () => {
  it("renders a dispatched run and completes the delivery", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    ingress.events = blockingEvents([
      agentEvent(2, {
        type: "text_delta",
        phase: "commentary",
        messageId: "checkpoint-1",
        text: "正在处理",
      }),
      agentEvent(3, { type: "tool_start", toolCallId: "t1", name: "Read" }),
      agentEvent(4, { type: "text_delta", text: "answer" }),
      terminalEvent(5),
    ]);

    const w = watcher(ingress, api);
    await w.openRun("run_1", turn());
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(api.sendMessage).toHaveBeenCalledWith(
      "telegram:42",
      "⏳ Agent 正在处理…",
      undefined,
    );
    expect(api.editMessage).toHaveBeenCalledWith(
      "telegram:42",
      8,
      "answer",
    );
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.editMessage).toHaveBeenCalledTimes(1);
    expect(ingress.completeDelivery).toHaveBeenCalledWith(
      "turn_1",
      expect.stringMatching(/^telegram:inst-1:run_1$/),
    );
    w.abort();
  });

  it("replays the terminal when the final edit and fallback both fail", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    let edits = 0;
    let sends = 0;
    api.editMessage = vi.fn(async () => {
      edits += 1;
      throw new Error("edit boom");
    });
    api.sendMessage = vi.fn(async () => {
      sends += 1;
      if (sends > 1) throw new Error("send boom");
      return { message_id: 8 };
    });
    ingress.events = blockingEvents([
      agentEvent(4, { type: "text_delta", text: "answer" }),
      terminalEvent(5),
    ]);

    const w = watcher(ingress, api);
    await w.openRun("run_1", turn());
    w.start(0);

    await waitUntil(() => edits >= 2);

    expect(ingress.completeDelivery).not.toHaveBeenCalled();
    w.abort();
  });

  it("notifies on a permission request", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    ingress.events = blockingEvents([
      agentEvent(4, { type: "permission_request", title: "写入文件" }),
      terminalEvent(5),
    ]);

    const w = watcher(ingress, api);
    await w.openRun("run_1", turn());
    w.start(0);

    await waitUntil(
      () =>
        api.sendMessage.mock.calls.some((call) =>
          String(call[1]).includes("Agent 请求权限"),
        ),
    );

    expect(
      api.sendMessage.mock.calls.some((call) =>
        String(call[1]).includes("写入文件"),
      ),
    ).toBe(true);
    w.abort();
  });

  it("recovers a delivering run by editing its existing message", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    ingress.events = blockingEvents([
      agentEvent(4, { type: "text_delta", text: "final" }),
      terminalEvent(5),
    ]);

    const w = watcher(ingress, api);
    w.resumeRun("run_1", "8", "turn_1", "telegram:old:run_1", false, "telegram:42", undefined);
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(api.editMessage).toHaveBeenCalledWith("telegram:42", 8, "final");
    expect(ingress.claimDelivery).not.toHaveBeenCalled();
    w.abort();
  });

  it("renders an idempotent Flow lifecycle into the same pending message", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    const artifact = flowEvent(6, "ARTIFACT_CREATED", "artifact_1", {
      artifact_id: "artifact_1",
      step_id: "deploy",
      name: "deploy.output.json",
    }, "artifact://artifact_1");
    ingress.events = blockingEvents([
      flowEvent(1, "STEP_STARTED", "deploy", { capability_id: "deploy.production" }),
      flowEvent(2, "STEP_STARTED", "deploy", { capability_id: "deploy.production" }),
      flowEvent(3, "APPROVAL_REQUESTED", "deploy.production", {
        approval_id: "approval_1",
        step_id: "deploy",
      }),
      flowEvent(4, "APPROVAL_GRANTED", "deploy.production", {
        approval_id: "approval_1",
        step_id: "deploy",
      }),
      flowEvent(5, "STEP_SUCCEEDED", "deploy"),
      artifact,
      { ...artifact, sequence: 7 },
      flowEvent(8, "FLOW_BATCH_DRAFTED", "batch_draft_1", {
        draft_id: "batch_draft_1", flow_id: "flow_deploy", status: "ready", total: 3, blocking: 0,
      }),
      flowEvent(9, "RUN_SNAPSHOT", "run_1", {
        flow_id: "flow_deploy",
        flow_revision: "sha256:revision",
        outcome: "succeeded",
        steps: [{
          step_id: "deploy",
          capability_id: "deploy.production",
          output_ref: "artifact://artifact_1",
          verification_status: "passed",
        }],
      }),
      terminalEvent(10),
    ]);

    const w = watcher(ingress, api);
    w.resumeRun(
      "run_1",
      "8",
      "turn_1",
      "telegram:old:run_1",
      false,
      "telegram:42",
      undefined,
    );
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(api.editMessage.mock.calls.length).toBeGreaterThan(1);
    expect(api.editMessage.mock.calls.every((call) => call[1] === 8)).toBe(true);
    expect(api.editMessage.mock.calls.some((call) => {
      const content = String(call[2]);
      return content.includes("/flow approve") && content.includes("Web Workbench");
    })).toBe(true);
    const finalText = String(api.editMessage.mock.calls.at(-1)?.[2]);
    expect(finalText).toContain("Flow 结果 · 成功");
    expect(finalText).toContain("Flow 批量草稿 · ready");
    expect(finalText.match(/deploy\.output\.json/g)).toHaveLength(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
    w.abort();
  });

  it("keeps final delivery successful after a transient live edit failure", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    const logs: string[] = [];
    let edits = 0;
    api.editMessage = vi.fn(async () => {
      edits += 1;
      if (edits === 1) throw new Error("live edit boom");
      return { message_id: 8 };
    });
    ingress.events = blockingEvents([
      flowEvent(1, "STEP_STARTED", "deploy", { capability_id: "deploy.production" }),
      flowEvent(2, "RUN_SNAPSHOT", "run_1", {
        flow_id: "flow_deploy",
        flow_revision: "sha256:revision",
        outcome: "succeeded",
        steps: [{
          step_id: "deploy",
          capability_id: "deploy.production",
          verification_status: "passed",
        }],
      }),
      terminalEvent(3),
    ]);

    const w = watcher(ingress, api, (message) => logs.push(message));
    w.resumeRun("run_1", "8", "turn_1", "telegram:old:run_1", false, "telegram:42", undefined);
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(logs.some((message) => message.includes("实时消息更新失败"))).toBe(true);
    expect(api.editMessage.mock.calls.at(-1)?.[2]).toContain("Flow 结果 · 成功");
    expect(ingress.completeDelivery).toHaveBeenCalledTimes(1);
    w.abort();
  });

  it("renders a rejected approval before a cancelled Flow terminal", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    ingress.events = blockingEvents([
      flowEvent(1, "APPROVAL_REQUESTED", "deploy.production", {
        approval_id: "approval_1",
        step_id: "deploy",
      }),
      flowEvent(2, "APPROVAL_REJECTED", "deploy.production", {
        approval_id: "approval_1",
        step_id: "deploy",
      }),
      flowEvent(3, "RUN_SNAPSHOT", "run_1", {
        flow_id: "flow_deploy",
        flow_revision: "sha256:revision",
        outcome: "failed",
        steps: [],
      }),
      terminalEvent(4, "RUN_CANCELLED"),
    ]);

    const w = watcher(ingress, api);
    w.resumeRun("run_1", "8", "turn_1", "telegram:old:run_1", false, "telegram:42", undefined);
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(api.editMessage.mock.calls.some((call) =>
      String(call[2]).includes("Flow 步骤审批已拒绝")
    )).toBe(true);
    expect(api.editMessage.mock.calls.at(-1)?.[2]).toContain("Flow 结果 · 失败");
    w.abort();
  });

  it("does not advance the cursor when complete returns false", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    let completes = 0;
    ingress.completeDelivery = vi.fn(async () => {
      completes += 1;
      return completes > 1;
    });
    ingress.events = blockingEvents([terminalEvent(5)]);

    const w = watcher(ingress, api);
    w.resumeRun("run_1", "8", "turn_1", "telegram:old:run_1", false, "telegram:42", undefined);
    w.start(0);

    await waitUntil(() => completes >= 2);

    const calls = ingress.events.mock.calls as unknown as Array<
      [string, { afterSequence: number }]
    >;
    expect(calls[0]?.[1]).toMatchObject({ afterSequence: 0 });
    expect(calls[1]?.[1]).toMatchObject({ afterSequence: 0 });
    w.abort();
  });

  it("replays when the permission notification fails to send", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    let sends = 0;
    api.sendMessage = vi.fn(async () => {
      sends += 1;
      if (sends > 1) throw new Error("send boom");
      return { message_id: 8 };
    });
    ingress.events = blockingEvents([
      agentEvent(4, { type: "permission_request", title: "写入文件" }),
      terminalEvent(5),
    ]);

    const w = watcher(ingress, api);
    await w.openRun("run_1", turn());
    w.start(0);

    await waitUntil(() => sends >= 3);

    expect(ingress.completeDelivery).not.toHaveBeenCalled();
    w.abort();
  });

  it("recovers a pending turn via TURN_DISPATCHED", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    ingress.events = blockingEvents([
      {
        type: "TURN_DISPATCHED",
        sequence: 5,
        runId: "run_1",
        occurredAt: "2026-08-21T10:00:05.000Z",
        target: "turn_1",
        resultRef: null,
        payload: {},
      },
    ]);

    const w = watcher(ingress, api);
    w.registerPendingTurn("turn_1", turn());
    w.start(0);

    await waitUntil(() => ingress.claimDelivery.mock.calls.length >= 1);

    expect(ingress.claimDelivery).toHaveBeenCalledWith(
      "turn_1",
      expect.stringMatching(/^telegram:inst-1:run_1$/),
    );
    w.abort();
  });

  it("recovers a dispatched delivery by opening its renderer", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    const w = watcher(ingress, api);

    await w.openRun("run_1", turn());

    expect(api.sendMessage).toHaveBeenCalledWith(
      "telegram:42",
      "⏳ Agent 正在处理…",
      undefined,
    );
    expect(ingress.ackDelivery).toHaveBeenCalledWith(
      "turn_1",
      expect.stringMatching(/^telegram:inst-1:run_1$/),
      "8",
    );
    w.abort();
  });

  it("falls back to the topic thread on a delivering run", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    api.editMessage = vi.fn(async () => {
      throw new Error("edit boom");
    });
    ingress.events = blockingEvents([
      agentEvent(4, { type: "text_delta", text: "final" }),
      terminalEvent(5),
    ]);

    const w = watcher(ingress, api);
    w.resumeRun(
      "run_1",
      "8",
      "turn_1",
      "telegram:old:run_1",
      false,
      "telegram:42",
      "12345",
    );
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(api.sendMessage).toHaveBeenCalledWith(
      "telegram:42",
      "final",
      "12345",
    );
    w.abort();
  });
});
