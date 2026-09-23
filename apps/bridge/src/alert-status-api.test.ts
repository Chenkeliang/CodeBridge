import { describe, expect, it, vi } from "vitest";
import type { SqliteEventStore } from "@codebridge/work-items";
import { createOutboundApp } from "./outbound-api.js";
function fixture() {
  const set = vi.fn(async () => {});
  const store = { getRun: (id: string) => id === "run1" ? { id, status: "running", turnId: "turn1" } : undefined,
    listDeliveries: (channel: string) => channel === "feishu" ? [{ runId: "run1", turnId: "turn1", conversationId: "oc_alert|om_original" }] : [] } as unknown as SqliteEventStore;
  const app = createOutboundApp({ sendOutboundFile: vi.fn(), sendOutboundMarkdown: vi.fn(), sendOutboundMention: vi.fn(), setOutboundAlertStatus: set }, "runner-secret", {
    workItemStore: store,
    publishers: () => [{ label: "publisher", token: "publisher-token", chatId: "oc_alert", routes: ["markdown", "mention"] }],
  });
  const request = (body: unknown, token = "runner-secret") => app.request("/outbound/alert-status", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { set, request };
}
describe("run-bound alert status API", () => {
  it("uses only the persisted run destination, ignoring caller-supplied targets", async () => {
    const f = fixture();
    const response = await f.request({ runId: "run1", chatId: "oc_wrong", topicId: "om_wrong", messageId: "om_wrong", status: "waiting", summary: "请确认补货" });
    expect(response.status).toBe(200);
    expect(f.set).toHaveBeenCalledWith("oc_alert", "om_original", "waiting", "请确认补货");
  });
  it("rejects publishers, missing runs and inactive runs", async () => {
    const f = fixture();
    expect((await f.request({ runId: "run1", status: "resolved", summary: "x" }, "publisher-token")).status).toBe(401);
    expect((await f.request({ status: "resolved", summary: "x" })).status).toBe(400);
    expect((await f.request({ runId: "unknown", status: "resolved", summary: "x" })).status).toBe(400);
    expect(f.set).not.toHaveBeenCalled();
  });
});
