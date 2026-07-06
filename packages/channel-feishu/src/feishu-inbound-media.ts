import type { Readable } from "node:stream";
import type { RunAttachment } from "@feishu-code-bridge/core";
import type { LarkChannel, ResourceDescriptor } from "@larksuiteoapi/node-sdk";

async function bufferFromDownloadResponse(raw: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (typeof raw === "object" && raw !== null) {
    const r = raw as {
      getReadableStream?: () => Readable;
      data?: Buffer | Uint8Array;
    };
    if (typeof r.getReadableStream === "function") {
      return readableToBuffer(r.getReadableStream());
    }
    if (Buffer.isBuffer(r.data)) return r.data;
    if (r.data instanceof Uint8Array) return Buffer.from(r.data);
  }
  throw new Error("unexpected download response type");
}

function readableToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** 下载用户消息中的图片（需 message_id + file_key 配对） */
export async function downloadMessageImage(
  channel: LarkChannel,
  messageId: string,
  fileKey: string,
): Promise<Buffer> {
  const r = await channel.rawClient.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: "image" },
  });
  return bufferFromDownloadResponse(r);
}

export function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46
  ) {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return "image/png";
}

export function mimeToImageExt(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".png";
  }
}

export function imageAttachmentName(index: number, mimeType: string): string {
  return `feishu-image-${index + 1}${mimeToImageExt(mimeType)}`;
}

export function resolveInboundPrompt(
  content: string,
  imageCount: number,
): string {
  const stripped = content
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/<file[^>]*\/>/g, "")
    .trim();
  if (stripped) return stripped;
  if (imageCount > 0) return "请分析用户发送的图片。";
  return "";
}

export async function downloadInboundImages(
  channel: LarkChannel,
  messageId: string,
  resources: ResourceDescriptor[],
): Promise<RunAttachment[]> {
  const images = resources.filter((r) => r.type === "image");
  const out: RunAttachment[] = [];
  for (let i = 0; i < images.length; i++) {
    const resource = images[i]!;
    const buf = await downloadMessageImage(
      channel,
      messageId,
      resource.fileKey,
    );
    const mimeType = sniffImageMime(buf);
    out.push({
      name: resource.fileName ?? imageAttachmentName(i, mimeType),
      mimeType,
      dataBase64: buf.toString("base64"),
    });
  }
  return out;
}
