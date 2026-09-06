import {describe, it, expect, vi} from "vitest";
import type {HttpInstance} from "@larksuiteoapi/node-sdk";
import {feishuHttpClient} from "./feishu-http.js";

describe("CardKit HTTP timeouts", () => {
  it("bounds stalled card requests without changing other SDK requests", async () => {
    const request = vi.fn(async (_opts: unknown) => ({code: 0}));
    const http = feishuHttpClient({request} as unknown as HttpInstance);
    const url = "https://open.feishu.cn/open-apis/cardkit/v1/cards/entity";
    await http.put(url, {card: {}}, {timeout: 0});
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({method: "PUT", timeout: 15_000}));
    await http.request({url, timeout: 500});
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({timeout: 500}));
    await http.get("https://open.feishu.cn/open-apis/im/v1/files/file", {timeout: 120_000});
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({timeout: 120_000}));
  });
});
