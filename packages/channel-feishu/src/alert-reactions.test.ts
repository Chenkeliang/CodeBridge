import { describe, expect, it, vi } from "vitest";
import type { Client } from "@larksuiteoapi/node-sdk";
import { setAlertReaction, findOwnerDoneReaction } from "./alert-reactions.js";
const managed = ["OnIt", "OneSecond", "DONE", "CrossMark", "Sigh"];
function fixture() {
  const list = vi.fn(async () => ({ code: 0, data: { items: [], has_more: false, page_token: "" } }));
  const create = vi.fn(async () => ({ code: 0, data: { reaction_id: "new" } }));
  const remove = vi.fn(async () => ({ code: 0 }));
  return { list, create, remove, client: { im: { v1: { messageReaction: { list, create, delete: remove } } } } as unknown as Client };
}
describe("alert state reactions", () => {
  it("replaces only the bot's managed reaction, preserving everyone else's and its unrelated reactions", async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce({ code: 0, data: { items: [
      { reaction_id: "old", operator: { operator_type: "app", operator_id: "cli_self" }, reaction_type: { emoji_type: "OnIt" } },
      { reaction_id: "human", operator: { operator_type: "user", operator_id: "ou_owner" }, reaction_type: { emoji_type: "OnIt" } },
      { reaction_id: "otherbot", operator: { operator_type: "app", operator_id: "cli_other" }, reaction_type: { emoji_type: "DONE" } },
      { reaction_id: "unrelated", operator: { operator_type: "app", operator_id: "cli_self" }, reaction_type: { emoji_type: "THUMBSUP" } },
    ], has_more: false, page_token: "" } } as never);
    expect(await setAlertReaction(f.client, "cli_self", "om_source", "CrossMark", managed)).toBe("new");
    expect(f.create).toHaveBeenCalledWith({ path: { message_id: "om_source" }, data: { reaction_type: { emoji_type: "CrossMark" } } });
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.remove).toHaveBeenCalledWith({ path: { message_id: "om_source", reaction_id: "old" } });
    expect(f.create.mock.invocationCallOrder[0]).toBeLessThan(f.remove.mock.invocationCallOrder[0]!);
  });
  it("reads all pages and reuses an already-added target state after an uncertain previous request", async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce({ code: 0, data: { items: [], has_more: true, page_token: "next" } });
    f.list.mockResolvedValueOnce({ code: 0, data: { items: [{ reaction_id: "existing", operator: { operator_type: "app", operator_id: "cli_self" }, reaction_type: { emoji_type: "Sigh" } }], has_more: false, page_token: "" } } as never);
    expect(await setAlertReaction(f.client, "cli_self", "om_source", "Sigh", managed)).toBe("existing");
    expect(f.list).toHaveBeenLastCalledWith({ path: { message_id: "om_source" }, params: { page_size: 50, page_token: "next" } });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("does not remove an old status if the new one cannot be created", async () => {
    const f = fixture(); f.create.mockResolvedValueOnce({ code: 99991672 } as never);
    await expect(setAlertReaction(f.client, "cli_self", "om_source", "DONE", managed)).rejects.toThrow("99991672");
    expect(f.remove).not.toHaveBeenCalled();
  });
});


it("reads only the human owner's DONE and ignores old or undated marks after reopening", async () => {
  const f = fixture();
  const items = [
    { reaction_id: "bot", operator: { operator_type: "app", operator_id: "ou_owner" }, reaction_type: { emoji_type: "DONE" }, action_time: "100" },
    { reaction_id: "other", operator: { operator_type: "user", operator_id: "ou_other" }, reaction_type: { emoji_type: "DONE" }, action_time: "100" },
    { reaction_id: "owner", operator: { operator_type: "user", operator_id: "ou_owner" }, reaction_type: { emoji_type: "DONE" }, action_time: "100" },
  ];
  f.list.mockResolvedValue({ code: 0, data: { items, has_more: false, page_token: "" } } as never);
  expect(await findOwnerDoneReaction(f.client, "om_source", "ou_owner")).toEqual({ messageId: "om_source", operatorOpenId: "ou_owner", emojiType: "DONE", action: "added", actionTime: 100 });
  expect(await findOwnerDoneReaction(f.client, "om_source", "ou_owner", 101)).toBeUndefined();
  f.list.mockResolvedValue({ code: 0, data: { items: [{ ...items[2], action_time: undefined }], has_more: false, page_token: "" } } as never);
  expect(await findOwnerDoneReaction(f.client, "om_source", "ou_owner", 101)).toBeUndefined();
});
