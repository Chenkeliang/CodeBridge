import path from "node:path";
import type { LocalMediaPath } from "@codebridge/core";

export function isImageMime(mime?: string): boolean {
  return (mime ?? "").startsWith("image/");
}

export function partitionAttachments(attachments: LocalMediaPath[] | undefined): {
  images: LocalMediaPath[];
  files: LocalMediaPath[];
} {
  const images: LocalMediaPath[] = [];
  const files: LocalMediaPath[] = [];
  for (const att of attachments ?? []) {
    if (isImageMime(att.mimeType)) images.push(att);
    else files.push(att);
  }
  return { images, files };
}

export function fileAttachmentPromptSuffix(files: LocalMediaPath[]): string {
  if (!files.length) return "";
  const lines = files.map((file) => {
    const name = file.name || path.basename(file.path);
    const mime = file.mimeType || "application/octet-stream";
    return `- ${name} (${mime}): ${file.path}`;
  });
  return `\n\n【用户附件已保存到本地，请用 Read 等工具打开该路径】\n${lines.join("\n")}`;
}
