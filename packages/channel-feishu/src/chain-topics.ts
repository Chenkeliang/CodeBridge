/**
 * 普通群没有 thread_id，但「回复串」消息带 root_id（串首消息 id）。
 * 把回复串映射到会话 topic：
 * - 群根直接发起的对话：串首消息登记为群级会话，后续对它（或 bot 回复）的
 *   回复仍延续同一会话；
 * - 回复陌生消息（如其他机器人的告警推送）发起的串：以串首消息 id 为独立
 *   topic，自动获得全新 Agent session。
 * 映射仅存内存；Bridge 重启后旧串的回复会按新话题开启新会话。
 */
export class ChainTopicTracker {
  /** 串首消息 id → topic（"" 表示群级会话） */
  private readonly rootTopic = new Map<string, string>();

  constructor(private readonly maxEntries = 2000) {}

  /** 登记一条群根消息属于群级会话，其回复串不另开话题 */
  recordGroupRoot(messageId: string): void {
    if (
      !this.rootTopic.has(messageId) &&
      this.rootTopic.size >= this.maxEntries
    ) {
      const oldest = this.rootTopic.keys().next().value;
      if (oldest !== undefined) this.rootTopic.delete(oldest);
    }
    this.rootTopic.set(messageId, "");
  }

  /** 解析回复串所属 topic；返回 undefined 表示群级会话 */
  resolve(rootId: string | undefined): string | undefined {
    if (!rootId) return undefined;
    const topic = this.rootTopic.get(rootId) ?? rootId;
    return topic || undefined;
  }
}
