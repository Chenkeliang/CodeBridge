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
