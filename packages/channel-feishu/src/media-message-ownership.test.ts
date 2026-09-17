import { expect, it, vi } from "vitest";
import * as sdk from "@larksuiteoapi/node-sdk";
import { defaultConfig } from "@codebridge/core";
import { FeishuBridge } from "./bridge.js";
import os from "node:os";

it("preserves resource/message pairs through the real SDK batching pipeline", async () => {
  const create = sdk.createLarkChannel;
  const received: Array<{ messageId: string; resources: Array<{ fileKey: string }> }> = [];
  let channel: ReturnType<typeof create>;
  const spy = vi.spyOn(sdk, "createLarkChannel").mockImplementation((options) => {
    channel = create(options);
    vi.spyOn(channel, "connect").mockResolvedValue(undefined);
    return channel;
  });
  const bridge = new FeishuBridge({ config: defaultConfig(), dataDir: os.tmpdir() });
  const target = bridge as unknown as { dispatchInboundMessage: (msg: typeof received[number]) => Promise<void> };
  target.dispatchInboundMessage = async (msg) => { received.push(msg); };
  try {
    await bridge.connect();
    const safety = (channel! as unknown as { safety: { pushMessage(msg: unknown): Promise<void>; dispose(): Promise<void> } }).safety;
    const id = Date.now().toString();
    for (const n of [1, 2]) await safety.pushMessage({ messageId: `${id}-${n}`, chatId: "chat", chatType: "p2p",
      senderId: "user", createTime: Date.now(), content: "image", resources: [{ type: "image", fileKey: `image-${n}` }], mentions: [] });
    await safety.dispose();
    expect(received.map((msg) => [msg.messageId, msg.resources[0]?.fileKey])).toEqual([
      [`${id}-1`, "image-1"], [`${id}-2`, "image-2"],
    ]);
  } finally {
    await bridge.disconnect();
    spy.mockRestore();
  }
});
