import type { AlertIncidentView } from "@codebridge/core";
import type { SessionCatalogStore } from "@codebridge/session-catalog";
import type { SqliteEventStore } from "@codebridge/work-items";
import type { FeishuAlertMonitor } from "./feishu-alert-monitor.js";

/** Join canonical incident state to retained delivery history, including completed deliveries. */
export function readAlertIncidents(monitor: Pick<FeishuAlertMonitor, "listIncidents"> | undefined, items: SqliteEventStore, catalog: SessionCatalogStore, chatId: string): AlertIncidentView[] {
  if (!monitor) throw new Error("告警案件读取尚未就绪");
  return monitor.listIncidents(chatId).map((incident) => {
    const sessionId = items.listDeliveries("feishu", undefined, incident.id)
      .filter((delivery) => delivery.conversationId === `${chatId}|${incident.id}` && catalog.getSession(delivery.sessionId))
      .sort((a, b) => (b.runId ? items.getRun(b.runId)?.createdAt ?? "" : "").localeCompare(a.runId ? items.getRun(a.runId)?.createdAt ?? "" : ""))[0]?.sessionId ?? null;
    return { ...incident, sessionId };
  });
}
