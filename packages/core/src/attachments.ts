import type { LocalMediaPath } from "./types.js";

export function appendAttachmentPaths(
  prompt: string,
  attachments?: LocalMediaPath[],
): string {
  if (!attachments?.length) return prompt;
  const paths = attachments.map((a) => a.path).join("\n");
  return `${prompt}\n\n[附件图片]\n${paths}`;
}
