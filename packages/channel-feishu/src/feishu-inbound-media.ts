import path from "node:path";
import type { Readable } from "node:stream";
import type { RunAttachment } from "@codebridge/core";
import type { LarkChannel, ResourceDescriptor } from "@larksuiteoapi/node-sdk";

// Feishu requires range requests for resources >= 100 MB. Keep this path bounded.
export const MAX_INBOUND_ATTACHMENT_BYTES = 100_000_000 - 1;
export const MAX_INBOUND_MESSAGE_BYTES = MAX_INBOUND_ATTACHMENT_BYTES;

const FILE_EXT_MIME: Record<string, string> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  log: "text/plain",
  rtf: "application/rtf",
  ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  amr: "audio/amr",
  flac: "audio/flac",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  svg: "image/svg+xml",
  xml: "application/xml",
  html: "text/html",
  yaml: "application/yaml",
  yml: "application/yaml",
  gz: "application/gzip",
  tar: "application/x-tar",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
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

class AttachmentLimitError extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(`${formatBytes(bytes)}，超过 ${formatBytes(limit)}`);
  }
}

async function bufferFromDownloadResponse(raw: unknown, maxBytes: number): Promise<Buffer> {
  if (Buffer.isBuffer(raw)) {
    if (raw.length > maxBytes) throw new AttachmentLimitError(raw.length, maxBytes);
    return raw;
  }
  if (raw instanceof Uint8Array) {
    if (raw.byteLength > maxBytes) throw new AttachmentLimitError(raw.byteLength, maxBytes);
    return Buffer.from(raw);
  }
  if (typeof raw === "object" && raw !== null) {
    const r = raw as {
      getReadableStream?: () => Readable;
      data?: Buffer | Uint8Array;
    };
    if (typeof r.getReadableStream === "function") {
      return readableToBuffer(r.getReadableStream(), maxBytes);
    }
    if (Buffer.isBuffer(r.data)) return bufferFromDownloadResponse(r.data, maxBytes);
    if (r.data instanceof Uint8Array) return bufferFromDownloadResponse(r.data, maxBytes);
  }
  throw new Error("unexpected download response type");
}

async function readableToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new AttachmentLimitError(size, maxBytes);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  } finally {
    if (!stream.destroyed) stream.destroy();
  }
}

export type InboundResourceType = "image" | "file";

export function inboundResourceType(
  type: string | undefined,
): InboundResourceType | undefined {
  if (type === "image") return "image";
  if (type === "file" || type === "video" || type === "audio") return "file";
  return undefined;
}

/** 下载用户消息中的图片或文件（需 message_id + file_key 配对） */
export async function downloadMessageResource(
  channel: LarkChannel,
  messageId: string,
  fileKey: string,
  type: InboundResourceType,
  maxBytes = MAX_INBOUND_ATTACHMENT_BYTES,
): Promise<Buffer> {
  const r = await channel.rawClient.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });
  return bufferFromDownloadResponse(r, maxBytes);
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
  if (buf.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (buf.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0]))
    || buf.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0, 0x2a]))) return "image/tiff";
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp"
    && ["heic", "heix", "hevc", "hevx", "mif1"].includes(buf.toString("ascii", 8, 12))) return "image/heic";
  return "application/octet-stream";
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
    case "image/png":
      return ".png";
    case "image/bmp":
      return ".bmp";
    case "image/tiff":
      return ".tiff";
    case "image/heic":
      return ".heic";
    default:
      return ".bin";
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
    .replace(/<(?:file|video|audio)\b[^>]*\/>/g, "")
    .replace(/^\[(?:video|audio|file)\]$/i, "")
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
  return `${(n / 1_000_000).toFixed(1)}MB`;
}

export async function downloadInboundAttachments(
  channel: LarkChannel,
  messageId: string,
  resources: ResourceDescriptor[],
  maxTotalBytes = MAX_INBOUND_MESSAGE_BYTES,
): Promise<InboundDownloadResult> {
  const attachments: RunAttachment[] = [];
  const skipped: string[] = [];
  let imageIndex = 0;
  let fileIndex = 0;
  let totalBytes = 0;

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
    const remaining = Math.min(maxTotalBytes, MAX_INBOUND_MESSAGE_BYTES) - totalBytes;
    if (remaining <= 0) {
      skipped.push(`${label}（单条消息附件总量已达到 ${formatBytes(MAX_INBOUND_MESSAGE_BYTES)}）`);
      continue;
    }
    try {
      const buf = await downloadMessageResource(
        channel,
        messageId,
        resource.fileKey,
        type,
        Math.min(MAX_INBOUND_ATTACHMENT_BYTES, remaining),
      );
      totalBytes += buf.length;
      if (type === "image") {
        const mimeType = sniffImageMime(buf);
        attachments.push({
          name: resource.fileName ?? imageAttachmentName(imageIndex, mimeType),
          mimeType,
          dataBase64: buf.toString("base64"),
        });
        imageIndex += 1;
      } else {
        const mimeType = mimeFromFileName(resource.fileName)
          ?? (resource.type === "video" ? "video/mp4" : resource.type === "audio" ? "audio/ogg" : "application/octet-stream");
        const fileName = resource.fileName || (resource.type === "video"
          ? `feishu-video-${fileIndex + 1}.mp4`
          : resource.type === "audio" ? `feishu-audio-${fileIndex + 1}.ogg` : undefined);
        attachments.push({
          name: fileAttachmentName(fileIndex, fileName),
          mimeType,
          dataBase64: buf.toString("base64"),
        });
        fileIndex += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push(err instanceof AttachmentLimitError
        ? `${label}（${message}；单条消息总量限制 ${formatBytes(MAX_INBOUND_MESSAGE_BYTES)}）`
        : `${label}（下载失败：${message}）`);
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
