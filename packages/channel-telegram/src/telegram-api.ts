export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramApiOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

export function rawTelegramChatId(chatId: string): string {
  if (!chatId.startsWith("telegram:")) {
    throw new Error(`不是 Telegram chat id：${chatId}`);
  }
  return chatId.slice("telegram:".length);
}

export function chunkTelegramText(text: string, maxLength = 4096): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxLength) {
    chunks.push(text.slice(offset, offset + maxLength));
  }
  return chunks;
}

export class TelegramApi {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: TelegramApiOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://api.telegram.org";
  }

  getMe(): Promise<TelegramUser> {
    return this.request("getMe", {});
  }

  getUpdates(
    offset: number,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    return this.request("getUpdates", { offset, timeout }, signal);
  }

  sendMessage(
    chatId: string,
    text: string,
    topicId?: string,
  ): Promise<{ message_id: number }> {
    return this.request("sendMessage", {
      chat_id: rawTelegramChatId(chatId),
      text,
      ...(topicId ? { message_thread_id: Number(topicId) } : {}),
    });
  }

  editMessage(
    chatId: string,
    messageId: number,
    text: string,
  ): Promise<{ message_id: number }> {
    return this.request("editMessageText", {
      chat_id: rawTelegramChatId(chatId),
      message_id: messageId,
      text,
    });
  }

  async sendDocument(
    chatId: string,
    fileName: string,
    content: Uint8Array,
    topicId?: string,
  ): Promise<{ message_id: number }> {
    const form = new FormData();
    form.set("chat_id", rawTelegramChatId(chatId));
    if (topicId) form.set("message_thread_id", topicId);
    form.set("document", new Blob([content]), fileName);
    return this.request("sendDocument", form);
  }

  private async request<T>(
    method: string,
    body: object | FormData,
    signal?: AbortSignal,
  ): Promise<T> {
    const isForm = body instanceof FormData;
    const response = await this.fetchImpl(
      `${this.baseUrl}/bot${this.options.token}/${method}`,
      {
        method: "POST",
        headers: isForm ? undefined : { "Content-Type": "application/json" },
        body: isForm ? body : JSON.stringify(body),
        signal,
      },
    );
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      description?: string;
    } | null;
    if (!response.ok || !payload?.ok || payload.result === undefined) {
      throw new Error(
        payload?.description ?? `Telegram API ${method} failed: ${response.status}`,
      );
    }
    return payload.result;
  }
}
