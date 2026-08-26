import { describe, expect, it } from "vitest";
import type { LarkChannel, ResourceDescriptor } from "@larksuiteoapi/node-sdk";
import {
  MAX_INBOUND_ATTACHMENT_BYTES,
  downloadInboundAttachments,
  fileAttachmentName,
  imageAttachmentName,
  mimeFromFileName,
  resolveInboundPrompt,
  sniffImageMime,
} from "./feishu-inbound-media.js";

function fakeChannel(
  replies: Record<string, Buffer | Error>,
): LarkChannel {
  return {
    rawClient: {
      im: {
        v1: {
          messageResource: {
            get: async ({
              path,
              params,
            }: {
              path: { file_key: string };
              params: { type: string };
            }) => {
              const item = replies[`${params.type}:${path.file_key}`];
              if (item instanceof Error) throw item;
              if (!item) throw new Error(`unexpected ${params.type}:${path.file_key}`);
              return item;
            },
          },
        },
      },
    },
  } as unknown as LarkChannel;
}

describe("feishu-inbound-media", () => {
  it("sniffs png magic bytes", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffImageMime(buf)).toBe("image/png");
  });

  it("builds default attachment names", () => {
    expect(imageAttachmentName(0, "image/jpeg")).toBe("feishu-image-1.jpg");
    expect(fileAttachmentName(0, "报表.xlsx")).toBe("报表.xlsx");
    expect(fileAttachmentName(1, undefined)).toBe("feishu-file-2.bin");
  });

  it("maps common file extensions to mime types", () => {
    expect(mimeFromFileName("a.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(mimeFromFileName("notes.CSV")).toBe("text/csv");
    expect(mimeFromFileName("spec.pdf")).toBe("application/pdf");
    expect(mimeFromFileName("noext")).toBeUndefined();
  });

  it("strips resource markup and falls back for attachment-only messages", () => {
    expect(resolveInboundPrompt("![image](img_v3_abc)", 1)).toBe(
      "请查看用户发送的附件。",
    );
    expect(resolveInboundPrompt('<file key="file_v1" name="a.xlsx"/>', 1)).toBe(
      "请查看用户发送的附件。",
    );
    expect(
      resolveInboundPrompt("看看这个 ![image](img_v3_abc)", 1),
    ).toBe("看看这个");
  });

  it("downloads images with type=image and files with type=file", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const csv = Buffer.from("sku,qty\n1,2\n");
    const resources: ResourceDescriptor[] = [
      { type: "image", fileKey: "img_1" },
      { type: "file", fileKey: "file_1", fileName: "订单.csv" },
    ];
    const result = await downloadInboundAttachments(
      fakeChannel({
        "image:img_1": png,
        "file:file_1": csv,
      }),
      "om_1",
      resources,
    );
    expect(result.skipped).toEqual([]);
    expect(result.attachments).toEqual([
      {
        name: "feishu-image-1.png",
        mimeType: "image/png",
        dataBase64: png.toString("base64"),
      },
      {
        name: "订单.csv",
        mimeType: "text/csv",
        dataBase64: csv.toString("base64"),
      },
    ]);
  });

  it("skips oversized files, failed downloads, and unsupported types", async () => {
    const huge = Buffer.alloc(MAX_INBOUND_ATTACHMENT_BYTES + 1);
    const result = await downloadInboundAttachments(
      fakeChannel({
        "file:ok": Buffer.from("ok"),
        "file:boom": new Error("permission denied"),
        "file:huge": huge,
      }),
      "om_1",
      [
        { type: "file", fileKey: "ok", fileName: "ok.txt" },
        { type: "file", fileKey: "boom", fileName: "secret.pdf" },
        { type: "file", fileKey: "huge", fileName: "big.xlsx" },
        { type: "sticker", fileKey: "st_1" },
      ],
    );
    expect(result.attachments).toEqual([
      {
        name: "ok.txt",
        mimeType: "text/plain",
        dataBase64: Buffer.from("ok").toString("base64"),
      },
    ]);
    expect(result.skipped).toEqual([
      "secret.pdf（下载失败：permission denied）",
      "big.xlsx（20.0MB，超过 20.0MB）",
      "st_1（不支持的资源类型 sticker）",
    ]);
  });
});
