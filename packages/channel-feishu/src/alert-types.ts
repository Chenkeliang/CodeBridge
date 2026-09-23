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
  topicId: string;
  instructions: string;
}
