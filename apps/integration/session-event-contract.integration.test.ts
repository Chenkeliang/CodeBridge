import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../packages/core/src/index.js";
import {
  SessionCatalogStore,
  type AgentProfile,
} from "../../packages/session-catalog/src/index.js";
import { SessionCoordinator } from "../../packages/session-coordinator/src/index.js";
import { SqliteEventStore } from "../../packages/work-items/src/index.js";

const feishu = vi.hoisted(() => ({
  botIdentity: { name: "Contract Test Bot" },
  dispatcher: { register: vi.fn() },
  on: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  updateCard: vi.fn().mockResolvedValue(undefined),
  rawClient: {
    cardkit: {
      v1: {
        card: {
          idConvert: vi.fn().mockResolvedValue({
            code: 0,
            data: { card_id: "cardkit-recovered" },
          }),
          update: vi.fn().mockResolvedValue({ code: 0 }),
        },
      },
    },
  },
}));

import { FeishuBridge } from "../../packages/channel-feishu/src/bridge.js";
import { createChannelSessionIngress } from "../bridge/src/channel-ingress.js";
import { createSessionApp } from "../bridge/src/session-api.js";

const TOKEN = "session-event-contract-token";
const AGENTS: AgentProfile[] = [{
  agentId: "pi",
  displayName: "Pi",
  adapter: "sdk",
  status: "healthy",
  capabilities: ["session"],
  models: [],
  sessionFeatures: ["resume"],
}];
const tempDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  feishu.connect.mockResolvedValue(undefined);
  feishu.disconnect.mockResolvedValue(undefined);
  feishu.updateCard.mockResolvedValue(undefined);
  feishu.rawClient.cardkit.v1.card.idConvert.mockResolvedValue({
    code: 0,
    data: { card_id: "cardkit-recovered" },
  });
  feishu.rawClient.cardkit.v1.card.update.mockResolvedValue({ code: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("session event contract integration timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createFixture(idempotencyKey: string) {
  const catalog = new SessionCatalogStore(":memory:");
  const workItems = new SqliteEventStore(":memory:");
  const coordinator = new SessionCoordinator(workItems, { maxQueuedTurns: 8 });
  const session = catalog.createSession({ agentId: "pi" });
  const submitted = coordinator.submitTurn({
    sessionId: session.id,
    idempotencyKey,
    message: {
      text: "生成最终结果",
      attachmentIds: [],
      flowId: null,
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    },
    workItem: {
      title: "生成最终结果",
      mode: "auto",
      conversationId: `conv_${session.id}`,
      agentId: "pi",
      workspaceScope: [],
      riskLevel: "read_only",
    },
    delivery: {
      channel: "feishu",
      conversationId: "chat-contract|",
      replyToMessageId: "source-message",
      showThinking: false,
    },
  });
  catalog.updateSession(session.id, { taskRecordId: submitted.workItemId });
  const run = submitted.run!;
  const app = createSessionApp({
    catalog,
    agents: AGENTS,
    workItems,
    coordinator,
  }, TOKEN);
  const ingress = createChannelSessionIngress(app, TOKEN);
  const owner = `feishu:previous:${run.id}`;
  expect(await ingress.claimDelivery(submitted.turn.turnId, owner)).toBe(true);
  expect(await ingress.ackDelivery(
    submitted.turn.turnId,
    owner,
    "card-message-recovered",
    "cardkit-recovered",
  )).toBe(true);
  const delivery = (await ingress.listDeliveries("feishu"))[0]!;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-event-contract-"));
  tempDirs.push(dataDir);
  return {
    catalog,
    workItems,
    coordinator,
    session,
    submitted,
    run,
    ingress,
    owner,
    delivery,
    dataDir,
  };
}

async function createBridge(
  ingress: ReturnType<typeof createChannelSessionIngress>,
  dataDir: string,
): Promise<FeishuBridge> {
  const sdk = await import(
    "../../packages/channel-feishu/node_modules/@larksuiteoapi/node-sdk/lib/index.js"
  );
  vi.spyOn(sdk, "createLarkChannel").mockReturnValueOnce(feishu as never);
  return new FeishuBridge({
    config: defaultConfig(),
    dataDir,
    sessionIngress: ingress,
  });
}

async function closeFixture(
  bridge: FeishuBridge,
  catalog: SessionCatalogStore,
  workItems: SqliteEventStore,
): Promise<void> {
  await bridge.disconnect();
  catalog.close();
  workItems.close();
}

describe("Session event wire contract integration", () => {
  it("restores persisted Feishu output through the real JSON replay path", async () => {
    const fixture = await createFixture("terminal-recovery");
    const {
      catalog,
      workItems,
      coordinator,
      session,
      submitted,
      run,
      ingress,
      delivery,
      dataDir,
    } = fixture;

    workItems.appendEvent({
      workItemId: submitted.workItemId,
      runId: run.id,
      type: "AGENT_EVENT",
      actor: "agent",
      target: "text_delta",
      resultRef: "result://final",
      payload: {
        event: { type: "text_delta", text: "真实持久化的最终答案" },
      },
    });
    coordinator.finishRun({
      sessionId: session.id,
      runId: run.id,
      status: "succeeded",
    });
    const actualReplay = ingress.replayEvents!.bind(ingress);
    let recovered: Awaited<ReturnType<typeof actualReplay>> = [];
    const replaySpy = vi.spyOn(ingress, "replayEvents").mockImplementation(async (
      sessionId,
      options,
    ) => {
      recovered = await actualReplay(sessionId, options);
      return recovered;
    });
    const bridge = await createBridge(ingress, dataDir);

    try {
      await bridge.connect();
      await waitUntil(() => workItems.listDeliveries("feishu").length === 0);

      expect(replaySpy).toHaveBeenCalledWith(session.id, {
        afterSequence: delivery.acceptedSequence,
      });
      expect(recovered).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_EVENT",
          runId: run.id,
          resultRef: "result://final",
        }),
        expect.objectContaining({ type: "RUN_SUCCEEDED", runId: run.id }),
      ]));
      const writes = JSON.stringify(feishu.rawClient.cardkit.v1.card.update.mock.calls);
      expect(writes).toContain("真实持久化的最终答案");
      expect(writes).toContain("✅ **已完成**");
      expect(writes).not.toContain("结果恢复中");
      expect(writes).not.toContain("本次无输出");
    } finally {
      await closeFixture(bridge, catalog, workItems);
    }
  });

  it("streams live Session events into the existing Feishu card", async () => {
    const fixture = await createFixture("live-stream");
    const {
      catalog,
      workItems,
      coordinator,
      session,
      submitted,
      run,
      ingress,
      dataDir,
    } = fixture;
    const actualEvents = ingress.events.bind(ingress);
    const eventsSpy = vi.spyOn(ingress, "events").mockImplementation(
      (sessionId, options) => actualEvents(sessionId, options),
    );
    const bridge = await createBridge(ingress, dataDir);

    try {
      await bridge.connect();
      await waitUntil(() => eventsSpy.mock.calls.length > 0);

      workItems.appendEvent({
        workItemId: submitted.workItemId,
        runId: run.id,
        type: "AGENT_EVENT",
        actor: "agent",
        target: "text_delta",
        resultRef: "result://live-final",
        payload: {
          event: { type: "text_delta", text: "实时 SSE 的最终答案" },
        },
      });
      coordinator.finishRun({
        sessionId: session.id,
        runId: run.id,
        status: "succeeded",
      });

      await waitUntil(() => workItems.listDeliveries("feishu").length === 0);
      expect(eventsSpy).toHaveBeenCalledWith(session.id, expect.objectContaining({
        afterSequence: fixture.delivery.acceptedSequence,
        signal: expect.any(AbortSignal),
      }));
      const writes = JSON.stringify(feishu.rawClient.cardkit.v1.card.update.mock.calls);
      expect(writes).toContain("实时 SSE 的最终答案");
      expect(writes).toContain("✅ **已完成**");
      expect(writes).not.toContain("本次无输出");
    } finally {
      await closeFixture(bridge, catalog, workItems);
    }
  });
});
