import fs from "node:fs/promises";
import path from "node:path";
import type { LocalMediaPath, RunAttachment } from "@feishu-code-bridge/core";

export async function materializeAttachments(
  dataDir: string,
  runId: string,
  attachments?: RunAttachment[],
): Promise<LocalMediaPath[]> {
  if (!attachments?.length) return [];
  const dir = path.join(dataDir, "attachments", runId);
  await fs.mkdir(dir, { recursive: true });
  const out: LocalMediaPath[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]!;
    const safeName = path.basename(att.name || `attachment-${i + 1}.png`);
    const filePath = path.join(dir, safeName);
    await fs.writeFile(filePath, Buffer.from(att.dataBase64, "base64"));
    out.push({
      path: filePath,
      mimeType: att.mimeType,
      name: safeName,
    });
  }
  return out;
}
