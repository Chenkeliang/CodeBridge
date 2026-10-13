import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Restore through Codex so its session files and metadata stay in sync. */
export async function restoreArchivedCodexSession(
  sessionId: string,
  cwd: string,
): Promise<void> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const archived = await fs.readdir(path.join(codexHome, "archived_sessions"), {
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (!archived.some((entry) => entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`))) return;

  await execFileAsync(process.env.CODEX_PATH || "codex", [
    "--no-daemon", "unarchive", sessionId,
  ], { cwd, env: { ...process.env }, timeout: 15_000, maxBuffer: 1024 * 1024 });
}
