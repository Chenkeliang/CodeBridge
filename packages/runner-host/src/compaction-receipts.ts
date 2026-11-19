import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SessionCompactionResult } from "@codebridge/core";

export interface CompactionReceipt {
  session: string;
  fingerprint: string;
  result: SessionCompactionResult;
}

export function compactionDigest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function compactionReceiptFile(dataDir: string, id: string): string {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("invalid_compaction_request_id");
  return path.join(dataDir, "session-compactions", `${id}.json`);
}

export async function readCompactionReceipt(file: string): Promise<CompactionReceipt | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as CompactionReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeReceipt(file: string, receipt: CompactionReceipt): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(receipt));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function reserveCompactionReceipt(file: string, receipt: CompactionReceipt): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeReceipt(file, receipt);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function finishCompactionReceipt(file: string, receipt: CompactionReceipt): Promise<void> {
  const next = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeReceipt(next, receipt);
    await fs.rename(next, file);
  } finally {
    await fs.rm(next, { force: true });
  }
}
