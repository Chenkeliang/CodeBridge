import type { LarkChannel } from "@larksuiteoapi/node-sdk";

export interface P2pChatEnteredEvent {
  chat_id?: string;
  last_message_id?: string;
  operator_id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
}

export interface BotMenuEvent {
  event_key?: string;
  event_id?: string;
  operator?: {
    operator_name?: string;
    operator_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
  };
}

interface LarkChannelInternals {
  dispatcher: {
    register: (
      handlers: Record<string, (raw: unknown) => void | Promise<void>>,
    ) => void;
  };
}

function extractEventPayload<T>(raw: unknown): T {
  if (typeof raw !== "object" || raw === null) return {} as T;
  const envelope = raw as { event?: T; body?: { event?: T } };
  return (envelope.event ?? envelope.body?.event ?? raw) as T;
}

export function registerFeishuExtraEvents(
  channel: LarkChannel,
  handlers: {
    onP2pChatEntered?: (data: P2pChatEnteredEvent) => void | Promise<void>;
    onBotMenu?: (data: BotMenuEvent) => void | Promise<void>;
  },
): void {
  const internal = channel as unknown as LarkChannelInternals;
  const map: Record<string, (raw: unknown) => void | Promise<void>> = {};

  if (handlers.onP2pChatEntered) {
    map["im.chat.access_event.bot_p2p_chat_entered_v1"] = async (raw) => {
      await handlers.onP2pChatEntered!(
        extractEventPayload<P2pChatEnteredEvent>(raw),
      );
    };
  }

  if (handlers.onBotMenu) {
    map["application.bot.menu_v6"] = async (raw) => {
      await handlers.onBotMenu!(extractEventPayload<BotMenuEvent>(raw));
    };
  }

  if (Object.keys(map).length > 0) {
    internal.dispatcher.register(map);
  }
}
