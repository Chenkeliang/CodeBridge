import path from "node:path";
import type { Readable } from "node:stream";
import type { RunAttachment } from "@codebridge/core";
import type { LarkChannel, ResourceDescriptor } from "@larksuiteoapi/node-sdk";

export const MAX_INBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const FILE_EXT_MIME: Record<string, string> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

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

export type InboundResourceType = "image" | "file";

export function inboundResourceType(
  type: string | undefined,
): InboundResourceType | undefined {
  if (type === "image" || type === "file") return type;
  return undefined;
}

/** 下载用户消息中的图片或文件（需 message_id + file_key 配对） */
export async function downloadMessageResource(
  channel: LarkChannel,
  messageId: string,
  fileKey: string,
  type: InboundResourceType,
): Promise<Buffer> {
  const r = await channel.rawClient.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });
  return bufferFromDownloadResponse(r);
}

export async function downloadMessageImage(
  channel: LarkChannel,
  messageId: string,
  fileKey: string,
): Promise<Buffer> {
  return downloadMessageResource(channel, messageId, fileKey, "image");
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

export function mimeFromFileName(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (!ext) return undefined;
  return FILE_EXT_MIME[ext];
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

export function fileAttachmentName(
  index: number,
  fileName: string | undefined,
): string {
  const base = fileName?.trim() ? path.basename(fileName) : "";
  if (base && base !== "." && base !== "..") return base;
  return `feishu-file-${index + 1}.bin`;
}

export function resolveInboundPrompt(
  content: string,
  attachmentCount: number,
): string {
  const stripped = content
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/<file[^>]*\/>/g, "")
    .trim();
  if (stripped) return stripped;
  if (attachmentCount > 0) return "请查看用户发送的附件。";
  return "";
}

export interface InboundDownloadResult {
  attachments: RunAttachment[];
  skipped: string[];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export async function downloadInboundAttachments(
  channel: LarkChannel,
  messageId: string,
  resources: ResourceDescriptor[],
): Promise<InboundDownloadResult> {
  const attachments: RunAttachment[] = [];
  const skipped: string[] = [];
  let imageIndex = 0;
  let fileIndex = 0;

  for (const resource of resources) {
    const type = inboundResourceType(resource.type);
    const label = resource.fileName || resource.fileKey || "未命名附件";
    if (!type) {
      skipped.push(`${label}（不支持的资源类型 ${resource.type ?? "unknown"}）`);
      continue;
    }
    if (!resource.fileKey) {
      skipped.push(`${label}（缺少 file_key）`);
      continue;
    }
    try {
      const buf = await downloadMessageResource(
        channel,
        messageId,
        resource.fileKey,
        type,
      );
      if (buf.length > MAX_INBOUND_ATTACHMENT_BYTES) {
        skipped.push(
          `${label}（${formatBytes(buf.length)}，超过 ${formatBytes(MAX_INBOUND_ATTACHMENT_BYTES)}）`,
        );
        continue;
      }
      if (type === "image") {
        const mimeType = sniffImageMime(buf);
        attachments.push({
          name: resource.fileName ?? imageAttachmentName(imageIndex, mimeType),
          mimeType,
          dataBase64: buf.toString("base64"),
        });
        imageIndex += 1;
      } else {
        const mimeType =
          mimeFromFileName(resource.fileName) ?? "application/octet-stream";
        attachments.push({
          name: fileAttachmentName(fileIndex, resource.fileName),
          mimeType,
          dataBase64: buf.toString("base64"),
        });
        fileIndex += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push(`${label}（下载失败：${message}）`);
    }
  }

  return { attachments, skipped };
}

export async function downloadInboundImages(
  channel: LarkChannel,
  messageId: string,
  resources: ResourceDescriptor[],
): Promise<RunAttachment[]> {
  const { attachments } = await downloadInboundAttachments(
    channel,
    messageId,
    resources.filter((resource) => resource.type === "image"),
  );
  return attachments;
}
