import type { Client } from "@larksuiteoapi/node-sdk";

/** Replace only this application's managed state reactions on the original alert. */
export async function setAlertReaction(
  client: Client,
  appId: string,
  messageId: string,
  emojiType: string,
  managedEmojiTypes: string[],
): Promise<string> {
  if (!managedEmojiTypes.includes(emojiType)) throw new Error("Unmanaged alert reaction");
  const api = client.im.v1.messageReaction;
  type Item = NonNullable<Awaited<ReturnType<typeof api.list>>["data"]>["items"][number];
  const owned: Item[] = [];
  let pageToken: string | undefined;
  do {
    const response = await api.list({ path: { message_id: messageId }, params: { page_size: 50, page_token: pageToken } });
    if (response.code !== 0 || !response.data) throw new Error(`Reaction list failed (${response.code}): ${response.msg}`);
    owned.push(...response.data.items.filter((item) => item.operator?.operator_type === "app"
      && item.operator.operator_id === appId && managedEmojiTypes.includes(item.reaction_type?.emoji_type ?? "")));
    pageToken = response.data.has_more ? response.data.page_token : undefined;
    if (response.data.has_more && !pageToken) throw new Error("Incomplete reaction pagination");
  } while (pageToken);
  let reactionId = owned.find((item) => item.reaction_type?.emoji_type === emojiType)?.reaction_id;
  if (!reactionId) {
    const created = await api.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: emojiType } } });
    if (created.code !== 0 || !created.data?.reaction_id) throw new Error(`Reaction create failed (${created.code}): ${created.msg}`);
    reactionId = created.data.reaction_id;
  }
  // Add the new state before removing the old one; retries can read back the newly created state.
  for (const item of owned) {
    if (!item.reaction_id || item.reaction_id === reactionId) continue;
    const removed = await api.delete({ path: { message_id: messageId, reaction_id: item.reaction_id } });
    if (removed.code !== 0) throw new Error(`Reaction delete failed (${removed.code}): ${removed.msg}`);
  }
  return reactionId;
}

/** Read a human owner's DONE, excluding the bot's projected state and other users. */
export async function findOwnerDoneReaction(
  client: Client, messageId: string, ownerOpenId: string, after?: number,
): Promise<import("./alert-types.js").FeishuAlertReaction | undefined> {
  let pageToken: string | undefined;
  do {
    const result = await client.im.v1.messageReaction.list({ path: { message_id: messageId },
      params: { reaction_type: "DONE", user_id_type: "open_id", page_size: 50, page_token: pageToken } });
    if (result.code !== 0 || !result.data) throw new Error(`Owner reaction read failed (${result.code}): ${result.msg}`);
    for (const item of result.data.items) {
      if (item.operator?.operator_type !== "user" || item.operator.operator_id !== ownerOpenId || item.reaction_type?.emoji_type !== "DONE") continue;
      const rawTime = Number(item.action_time);
      const actionTime = Number.isFinite(rawTime) && rawTime > 0 ? rawTime : undefined;
      if (after !== undefined && (actionTime === undefined || actionTime <= after)) continue;
      return { messageId, operatorOpenId: ownerOpenId, emojiType: "DONE", action: "added", actionTime };
    }
    pageToken = result.data.has_more ? result.data.page_token : undefined;
    if (result.data.has_more && !pageToken) throw new Error("Incomplete owner reaction pagination");
  } while (pageToken);
  return undefined;
}
