import fs from "node:fs/promises";
import path from "node:path";
import type { LocalMediaPath, RunAttachment } from "@codebridge/core";

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  const characters: string[] = [];
  for (const character of value) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > maxBytes) break;
    characters.push(character);
  }
  return characters.join("");
}

export async function materializeAttachments(
  dataDir: string,
  runId: string,
  attachments?: RunAttachment[],
): Promise<LocalMediaPath[]> {
  if (!attachments?.length) return [];
  const dir = path.join(dataDir, "attachments", runId);
  await fs.mkdir(dir, { recursive: true });
  const out: LocalMediaPath[] = [];
  const usedNames = new Set<string>();
  try {
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i]!;
      const basename = path.posix.basename((att.name || "").replace(/\\/g, "/"));
      const sanitized = basename.normalize("NFC")
        .replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_")
        .replace(/[. ]+$/g, "");
      const originalName = sanitized || `attachment-${i + 1}.bin`;
      const originalExtension = path.extname(originalName);
      // Keep normal format extensions; an oversized suffix is filename content.
      const extension = Buffer.byteLength(originalExtension, "utf8") <= 32
        ? originalExtension
        : "";
      const stem = originalName.slice(0, originalName.length - extension.length);
      const stemBudget = 255 - Buffer.byteLength(extension, "utf8");
      let safeName = `${truncateUtf8(stem, stemBudget)}${extension}`;
      let suffix = 2;
      while (usedNames.has(safeName.toLowerCase())) {
        const collisionSuffix = `-${suffix++}`;
        safeName = `${truncateUtf8(stem, stemBudget - collisionSuffix.length)}${collisionSuffix}${extension}`;
      }
      usedNames.add(safeName.toLowerCase());
      const filePath = path.join(dir, safeName);
      await fs.writeFile(filePath, Buffer.from(att.dataBase64, "base64"));
      out.push({
        path: filePath,
        mimeType: att.mimeType,
        name: safeName,
      });
    }
  } catch (error) {
    await cleanupAttachments(dataDir, runId);
    throw error;
  }
  return out;
}

export async function cleanupAttachments(
  dataDir: string,
  runId: string,
): Promise<void> {
  const dir = path.join(dataDir, "attachments", runId);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
