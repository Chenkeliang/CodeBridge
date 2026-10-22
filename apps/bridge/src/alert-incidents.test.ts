import { describe, expect, it } from "vitest";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCoordinator } from "@codebridge/session-coordinator";
import type { AlertIncidentView } from "@codebridge/core";
import { readAlertIncidents } from "./alert-incidents.js";
describe("retained incident session destination", () => {
  it("finds the existing session of a completed delivery without changing domain state", () => {
    const catalog = new SessionCatalogStore(":memory:"), items = new SqliteEventStore(":memory:"), coordinator = new SessionCoordinator(items, { maxQueuedTurns: 10 });
    const session = catalog.createSession({ agentId: "codex", cwd: "/fixture", title: "Fixture investigation" });
    const receipt = coordinator.submitTurn({ sessionId: session.id, idempotencyKey: "fixture", message: { text: "Read fixture", attachmentIds: [], model: null, effort: null, permissionMode: null, executionKind: "agent", plan: null },
      workItem: { title: "Fixture", mode: "auto", conversationId: "conv_fixture", agentId: "codex", workspaceScope: ["/fixture"], riskLevel: "read_only" },
      delivery: { channel: "feishu", conversationId: "oc_fixture|om_fixture", replyToMessageId: "om_fixture", showThinking: false } });
    coordinator.finishRun({ sessionId: session.id, runId: receipt.run!.id, status: "succeeded" });
    items.withSessionTransaction((tx) => { tx.claimDelivery(receipt.turn.turnId, "fixture-owner", new Date().toISOString(), new Date(Date.now() + 60000).toISOString()); tx.ackDelivery(receipt.turn.turnId, "fixture-owner", "om_sent"); expect(tx.completeDelivery(receipt.turn.turnId, "fixture-owner")).toBe(true); });
    const incident: AlertIncidentView = { id: "om_fixture", chatId: "oc_fixture", status: "resolved", summary: "Resolved synthetic incident", content: "Synthetic original", senderAppId: "cli_fixture", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), repeatCount: 1, sourceMessageIds: ["om_fixture"], responsibleOpenIds: ["ou_fixture"], approverOpenIds: ["ou_fixture"], sessionId: null, dismissal: null };
    const source = { listIncidents: () => [incident] }, before = items.listEvents(receipt.workItemId).length;
    try { expect(items.listDeliveries("feishu")).toEqual([]); expect(readAlertIncidents(source, items, catalog, "oc_fixture")[0]?.sessionId).toBe(session.id); expect(items.listEvents(receipt.workItemId)).toHaveLength(before); }
    finally { items.close(); catalog.close(); }
  });
});
