import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLeaseStore } from "./session-lease.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function fixture() {
  const holder = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(holder as unknown as ChildProcess);
  const store = new SessionLeaseStore("/unused") as unknown as {
    acquireKernelLock: (path: string) => Promise<ChildProcess | null>;
  };
  return { holder, acquire: () => store.acquireKernelLock("/unused/probe.lock") };
}

describe("session lock startup deadline", () => {
  it("still fails and terminates a helper that never reports readiness", async () => {
    const f = fixture();
    const failure = expect(f.acquire()).rejects.toThrow("Timed out while acquiring the session lock");
    await vi.advanceTimersByTimeAsync(5001);
    await failure;
    expect(f.holder.kill).toHaveBeenCalledOnce();
  });

  it("does not let an overdue timer kill a holder whose ready data is queued", async () => {
    const f = fixture();
    const lease = f.acquire();
    vi.advanceTimersByTime(5000);
    f.holder.stdout.write("__CODEBRIDGE_LOCKED__\n");
    await expect(lease).resolves.toBe(f.holder);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.holder.kill).not.toHaveBeenCalled();
  });

  it("preserves a queued lock-contention exit instead of reporting a startup timeout", async () => {
    const f = fixture();
    const lease = f.acquire();
    vi.advanceTimersByTime(5000);
    f.holder.emit("exit", 75, null);
    await expect(lease).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.holder.kill).not.toHaveBeenCalled();
  });
});
