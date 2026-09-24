/** Channel transport values; alert policy and persistence live in the Bridge app. */
export interface FeishuAlertMessage {
  messageId: string;
  chatId: string;
  createdAt: number;
  senderId: string;
  senderType: string;
  content: string;
  rootId?: string;
}

export interface FeishuAlertPage {
  messages: FeishuAlertMessage[];
  hasMore: boolean;
  pageToken?: string;
}

export interface FeishuAlertReply {
  allowed: boolean;
  handled?: boolean;
  topicId: string;
  instructions: string;
}

export const FEISHU_ALERT_STATUSES = ["investigating", "waiting", "resolved", "no_action", "blocked", "dismissed"] as const;
export type FeishuAlertStatus = typeof FEISHU_ALERT_STATUSES[number];

export interface FeishuAlertReaction {
  messageId: string;
  operatorOpenId: string;
  emojiType: string;
  action: "added" | "removed";
  actionTime?: number;
}
