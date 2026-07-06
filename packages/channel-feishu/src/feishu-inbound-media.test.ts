import { describe, expect, it } from "vitest";
import {
  imageAttachmentName,
  resolveInboundPrompt,
  sniffImageMime,
} from "./feishu-inbound-media.js";

describe("feishu-inbound-media", () => {
  it("sniffs png magic bytes", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffImageMime(buf)).toBe("image/png");
  });

  it("builds default attachment names", () => {
    expect(imageAttachmentName(0, "image/jpeg")).toBe("feishu-image-1.jpg");
  });

  it("strips image markdown and falls back for image-only messages", () => {
    expect(
      resolveInboundPrompt("![image](img_v3_abc)", 1),
    ).toBe("请分析用户发送的图片。");
    expect(
      resolveInboundPrompt("看看这个 ![image](img_v3_abc)", 1),
    ).toBe("看看这个");
  });
});
