import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface SessionLease {
  lost: Promise<Error>;
  release(): Promise<void>;
}

const LOCK_READY = "__CODEBRIDGE_LOCKED__";
const LOCK_HELPER = [
  `process.stdout.write(${JSON.stringify(`${LOCK_READY}\n`)});`,
  "process.stdin.resume();",
].join("");

interface LockCommand {
  command: string;
  args: string[];
}

function lockCommand(lockPath: string): LockCommand {
  if (process.platform === "darwin") {
    return {
      command: "/usr/bin/lockf",
      args: [
        "-k",
        "-n",
        "-s",
        "-t",
        "0",
        lockPath,
        process.execPath,
        "-e",
        LOCK_HELPER,
      ],
    };
  }
  if (process.platform === "linux") {
    return {
      command: "/usr/bin/flock",
      args: [
        "-n",
        "-E",
        "75",
        lockPath,
        process.execPath,
        "-e",
        LOCK_HELPER,
      ],
    };
  }
  throw new Error(`Session leases are unsupported on ${process.platform}`);
}

export class SessionLeaseStore {
  private readonly leaseDir: string;

  constructor(dataDir: string) {
    this.leaseDir = path.join(dataDir, "session-leases");
  }

  async acquire(sessionId: string, runId: string): Promise<SessionLease | null> {
    await fs.mkdir(this.leaseDir, { recursive: true });
    const hash = crypto.createHash("sha256").update(sessionId).digest("hex");
    const lockPath = path.join(this.leaseDir, `${hash}.lock`);
    const handle = await fs.open(lockPath, "a", 0o600);
    await handle.close();

    const holder = await this.acquireKernelLock(lockPath);
    if (!holder) return null;

    let released = false;
    let reportLost: (error: Error) => void = () => {};
    const lost = new Promise<Error>((resolve) => {
      reportLost = resolve;
    });
    holder.once("exit", (code, signal) => {
      if (released) return;
      reportLost(
        new Error(
          `Session kernel-lock holder exited unexpectedly (code=${code ?? "none"}, signal=${signal ?? "none"})`,
        ),
      );
    });
    holder.once("error", (error) => {
      if (!released) reportLost(error);
    });

    try {
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({
          sessionId,
          runId,
          pid: process.pid,
          holderPid: holder.pid,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error) {
      await this.releaseKernelLock(holder);
      throw error;
    }

    return {
      lost,
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseKernelLock(holder);
      },
    };
  }

  private async acquireKernelLock(lockPath: string): Promise<ChildProcess | null> {
    const { command, args } = lockCommand(lockPath);
    const holder = spawn(command, args, {
      stdio: ["pipe", "pipe", "ignore"],
    });

    return await new Promise<ChildProcess | null>((resolve, reject) => {
      let stdout = "";
      let settled = false;
      const finish = (result: ChildProcess | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        holder.removeListener("error", onError);
        holder.removeListener("exit", onExit);
        holder.stdout?.removeListener("data", onData);
        if (error) reject(error);
        else resolve(result);
      };
      const onError = (error: Error): void => finish(null, error);
      const onExit = (): void => finish(null);
      const onData = (chunk: Buffer): void => {
        stdout += chunk.toString("utf8");
        if (!stdout.includes("\n")) return;
        if (stdout.trim() !== LOCK_READY) {
          finish(null, new Error("Session lock helper returned invalid output"));
          return;
        }
        finish(holder);
      };
      const timeout = setTimeout(() => {
        holder.kill();
        finish(null, new Error("Timed out while acquiring the session lock"));
      }, 5_000);

      holder.once("error", onError);
      holder.once("exit", onExit);
      holder.stdout?.on("data", onData);
      holder.stdin?.on("error", () => {});
    });
  }

  private async releaseKernelLock(holder: ChildProcess): Promise<void> {
    if (holder.exitCode !== null || holder.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      holder.once("exit", () => resolve());
    });
    holder.stdin?.end();
    await exited;
  }
}
