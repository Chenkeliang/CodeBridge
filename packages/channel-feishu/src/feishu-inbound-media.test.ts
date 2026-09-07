import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { LarkChannel, ResourceDescriptor } from "@larksuiteoapi/node-sdk";
import {
  MAX_INBOUND_ATTACHMENT_BYTES,
  downloadInboundAttachments,
  downloadMessageResource,
  inboundResourceType,
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
      "big.xlsx（100.0MB，超过 100.0MB；单条消息总量限制 100.0MB）",
      "st_1（不支持的资源类型 sticker）",
    ]);
  });
  it.each(["audio", "video"])("downloads native %s using the file resource endpoint", async (type) => {
    const result = await downloadInboundAttachments(fakeChannel({"file:media": Buffer.from("media")}), "om_media", [
      {type: type as "video" | "audio", fileKey: "media", fileName: type === "video" ? "movie.MOV" : "voice.mp3"},
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.attachments[0]?.mimeType).toBe(type === "video" ? "video/quicktime" : "audio/mpeg");
    expect(Buffer.from(result.attachments[0]!.dataBase64, "base64").toString()).toBe("media");
    expect(inboundResourceType(type)).toBe("file");
    expect(resolveInboundPrompt(`<${type} key="media"/>`, 0)).toBe("");
    expect(resolveInboundPrompt(`<${type} key="media"/>`, 1)).toBe("请查看用户发送的附件。");
  });

  it.each(["pdf", "doc", "docx", "xls", "xlsx", "txt", "ppt", "pptx", "csv", "tsv", "mp4", "webm", "zip", "7z"])("retains %s bytes and detects its MIME", async (extension) => {
    const data = Buffer.from([0, 1, 127, 255]);
    const result = await downloadInboundAttachments(fakeChannel({"file:key":data}), "om", [{type:"file",fileKey:"key",fileName:`测试.${extension}`}]);
    expect(result.attachments[0]?.mimeType).toBe(mimeFromFileName(`测试.${extension}`));
    expect(Buffer.from(result.attachments[0]!.dataBase64,"base64")).toEqual(data);
  });

  it("keeps unrecognized file extensions as binary rather than rejecting them", async () => {
    const result = await downloadInboundAttachments(fakeChannel({"file:k":Buffer.from("unknown")}), "om", [{type:"file",fileKey:"k",fileName:"custom.xyz"}]);
    expect(result.attachments[0]).toMatchObject({name:"custom.xyz",mimeType:"application/octet-stream"});
  });

  it("stops and destroys a streamed response as soon as its byte limit is crossed", async () => {
    let read = 0;
    const stream = Readable.from((async function* () { for(let i=0;i<100;i++){read++; yield Buffer.alloc(4);} })());
    const channel = {rawClient:{im:{v1:{messageResource:{get:async()=>({getReadableStream:()=>stream})}}}}} as unknown as LarkChannel;
    await expect(downloadMessageResource(channel,"om","k","file",8)).rejects.toThrow("超过");
    expect(read).toBeLessThan(100);
    expect(stream.destroyed).toBe(true);
  });

  it("caps the aggregate accepted message payload and still accepts a smaller later file", async () => {
    const result = await downloadInboundAttachments(fakeChannel({
      "file:first":Buffer.alloc(6), "file:large":Buffer.alloc(4), "file:last":Buffer.alloc(2),
    }), "om", [
      {type:"file",fileKey:"first",fileName:"one.txt"},
      {type:"file",fileKey:"large",fileName:"two.txt"},
      {type:"file",fileKey:"last",fileName:"three.txt"},
    ], 8);
    expect(result.attachments.map((a)=>a.name)).toEqual(["one.txt","three.txt"]);
    expect(result.skipped).toHaveLength(1);
  });

  it("does not mislabel unsupported or corrupt images as PNG", () => {
    expect(sniffImageMime(Buffer.from("not an image"))).toBe("application/octet-stream");
    expect(sniffImageMime(Buffer.from("0000ftypheic"))).toBe("image/heic");
  });

});
