import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionLeaseStore } from "./session-lease.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("SessionLeaseStore", () => {
  it("atomically rejects a second Runner and releases the kernel lock", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-lease-"));
    tmpDirs.push(dataDir);
    const first = new SessionLeaseStore(dataDir);
    const second = new SessionLeaseStore(dataDir);

    const lease = await first.acquire("session-1", "run-1");
    expect(lease).not.toBeNull();
    await expect(second.acquire("session-1", "run-2")).resolves.toBeNull();

    await lease?.release();
    const replacement = await second.acquire("session-1", "run-2");
    expect(replacement).not.toBeNull();
    await replacement?.release();
  });

  it("does not confuse different sessions", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-lease-"));
    tmpDirs.push(dataDir);
    const store = new SessionLeaseStore(dataDir);

    const first = await store.acquire("session-1", "run-1");
    const second = await store.acquire("session-2", "run-2");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    await first?.release();
    await second?.release();
  });

  it("ignores stale files from the legacy reclaim protocol", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-lease-"));
    tmpDirs.push(dataDir);
    const leaseDir = path.join(dataDir, "session-leases");
    fs.mkdirSync(leaseDir, { recursive: true });
    const hash = crypto.createHash("sha256").update("session-1").digest("hex");
    fs.writeFileSync(path.join(leaseDir, `${hash}.json`), "stale lease");
    fs.mkdirSync(path.join(leaseDir, `${hash}.json.reclaim`));

    const lease = await new SessionLeaseStore(dataDir).acquire(
      "session-1",
      "new-run",
    );

    expect(lease).not.toBeNull();
    await lease?.release();
  });

  it("reports an unexpected kernel-lock holder exit", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-lease-"));
    tmpDirs.push(dataDir);
    const lease = await new SessionLeaseStore(dataDir).acquire(
      "session-1",
      "run-1",
    );
    expect(lease).not.toBeNull();
    const hash = crypto.createHash("sha256").update("session-1").digest("hex");
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(dataDir, "session-leases", `${hash}.lock`),
        "utf8",
      ),
    ) as { holderPid: number };

    process.kill(metadata.holderPid, "SIGKILL");

    await expect(lease?.lost).resolves.toEqual(expect.any(Error));
    await lease?.release();
    const replacement = await new SessionLeaseStore(dataDir).acquire(
      "session-1",
      "run-2",
    );
    expect(replacement).not.toBeNull();
    await replacement?.release();
  });
});
