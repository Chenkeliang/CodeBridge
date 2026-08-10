import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ExecFileResult = { stdout: string };
type ExecFileRunner = (
  file: string,
  args: string[],
) => Promise<ExecFileResult>;

export interface CodexSessionOwnershipOptions {
  codexHome?: string;
  platform?: NodeJS.Platform;
  execFile?: ExecFileRunner;
}

const defaultExecFile: ExecFileRunner = async (file, args) => {
  const { stdout } = await execFileAsync(file, args);
  return { stdout: String(stdout) };
};

export async function filterForeignOwnerPids(
  pids: number[],
  allowedProcessGroups: ReadonlySet<number>,
  processGroupOf: (pid: number) => Promise<number | undefined>,
): Promise<number[]> {
  const foreign: number[] = [];
  for (const pid of pids) {
    const group = await processGroupOf(pid);
    if (group === undefined || !allowedProcessGroups.has(group)) foreign.push(pid);
  }
  return foreign;
}

async function findRolloutPath(
  directory: string,
  suffix: string,
  depth: number,
): Promise<string | undefined> {
  if (depth < 0) return undefined;
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .catch(() => undefined);
  if (!entries) return undefined;
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(suffix)) return candidate;
    if (entry.isDirectory()) {
      const found = await findRolloutPath(candidate, suffix, depth - 1);
      if (found) return found;
    }
  }
  return undefined;
}

async function processGroupOf(
  pid: number,
  run: ExecFileRunner,
): Promise<number | undefined> {
  try {
    const { stdout } = await run("ps", ["-o", "pgid=", "-p", String(pid)]);
    const value = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function inspectForeignCodexSessionOwners(
  sessionId: string,
  allowedProcessGroups: ReadonlySet<number>,
  options: CodexSessionOwnershipOptions = {},
): Promise<number[]> {
  if ((options.platform ?? process.platform) !== "darwin") return [];
  const codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
  const run = options.execFile ?? defaultExecFile;
  const suffix = `-${sessionId}.jsonl`;
  const rolloutPath =
    (await findRolloutPath(path.join(codexHome, "sessions"), suffix, 4)) ??
    (await findRolloutPath(path.join(codexHome, "archived_sessions"), suffix, 1));
  if (!rolloutPath) return [];

  let stdout = "";
  try {
    ({ stdout } = await run("lsof", ["-t", rolloutPath]));
  } catch (error) {
    const result = error as NodeJS.ErrnoException & { code?: number; stdout?: string };
    if (result.code === 1 || result.code === "ENOENT") return [];
    if (typeof result.stdout === "string") stdout = result.stdout;
    else throw error;
  }
  const pids = [...new Set(
    stdout
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value)),
  )];
  return filterForeignOwnerPids(pids, allowedProcessGroups, (pid) =>
    processGroupOf(pid, run),
  );
}
