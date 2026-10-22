import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "./index.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";

describe("provider session lease", () => {
  it("rejects a second claim while the first lease is live", () => {
    const store = new SqliteEventStore(":memory:");
    expect(
      store.claimProviderSession({
        agentId: "agent_a",
        providerSessionId: "prov_1",
        runId: "run_1",
        now: T0,
        expiresAt: T1,
      }),
    ).toBe(true);
    expect(
      store.claimProviderSession({
        agentId: "agent_a",
        providerSessionId: "prov_1",
        runId: "run_2",
        now: "2026-01-01T00:00:30.000Z",
        expiresAt: "2026-01-01T00:02:00.000Z",
      }),
    ).toBe(false);
    expect(
      store.findLiveProviderLease("agent_a", "prov_1", T0),
    ).toEqual({ runId: "run_1" });
    store.close();
  });

  it("reclaims an expired lease", () => {
    const store = new SqliteEventStore(":memory:");
    store.claimProviderSession({
      agentId: "agent_a",
      providerSessionId: "prov_1",
      runId: "run_1",
      now: T0,
      expiresAt: T1,
    });
    expect(
      store.claimProviderSession({
        agentId: "agent_a",
        providerSessionId: "prov_1",
        runId: "run_2",
        now: "2026-01-01T00:02:00.000Z",
        expiresAt: "2026-01-01T00:03:00.000Z",
      }),
    ).toBe(true);
    expect(
      store.findLiveProviderLease(
        "agent_a",
        "prov_1",
        "2026-01-01T00:02:30.000Z",
      ),
    ).toEqual({ runId: "run_2" });
    store.close();
  });

  it("allows the same owner to re-claim its live lease", () => {
    const store = new SqliteEventStore(":memory:");
    store.claimProviderSession({
      agentId: "agent_a",
      providerSessionId: "prov_1",
      runId: "run_1",
      now: T0,
      expiresAt: T1,
    });
    expect(
      store.claimProviderSession({
        agentId: "agent_a",
        providerSessionId: "prov_1",
        runId: "run_1",
        now: "2026-01-01T00:00:30.000Z",
        expiresAt: "2026-01-01T00:02:00.000Z",
      }),
    ).toBe(true);
    expect(
      store.findLiveProviderLease(
        "agent_a",
        "prov_1",
        "2026-01-01T00:00:30.000Z",
      ),
    ).toEqual({ runId: "run_1" });
    store.close();
  });

  it("release validates the owner", () => {
    const store = new SqliteEventStore(":memory:");
    store.claimProviderSession({
      agentId: "agent_a",
      providerSessionId: "prov_1",
      runId: "run_1",
      now: T0,
      expiresAt: T1,
    });
    expect(
      store.releaseProviderSession({
        agentId: "agent_a",
        providerSessionId: "prov_1",
        runId: "run_other",
      }),
    ).toBe(false);
    expect(
      store.releaseProviderSession({
        agentId: "agent_a",
        providerSessionId: "prov_1",
        runId: "run_1",
      }),
    ).toBe(true);
    expect(
      store.findLiveProviderLease("agent_a", "prov_1", T0),
    ).toBeUndefined();
    store.close();
  });

  it("renew extends the lease for the owner only", () => {
    const store = new SqliteEventStore(":memory:");
    store.claimProviderSession({
      agentId: "agent_a",
      providerSessionId: "prov_1",
      runId: "run_1",
      now: T0,
      expiresAt: T1,
    });
    expect(
      store.renewProviderSession({
        agentId: "agent_a",
        providerSessionId: "prov_1",
        runId: "run_1",
        expiresAt: "2026-01-01T00:10:00.000Z",
      }),
    ).toBe(true);
    expect(
      store.findLiveProviderLease(
        "agent_a",
        "prov_1",
        "2026-01-01T00:09:00.000Z",
      ),
    ).toEqual({ runId: "run_1" });
    // 非 owner 无法续期。
    expect(
      store.renewProviderSession({
        agentId: "agent_a",
        providerSessionId: "prov_1",
        runId: "run_2",
        expiresAt: "2026-01-01T00:20:00.000Z",
      }),
    ).toBe(false);
    store.close();
  });

  it("renew still succeeds for the original owner after the lease has expired, as long as no other run has claimed it", () => {
    const store = new SqliteEventStore(":memory:");
    store.claimProviderSession({
      agentId: "agent_a",
      providerSessionId: "prov_1",
      runId: "run_1",
      now: T0,
      expiresAt: T1,
    });
    // T1 已过期，但没有其它 Run 抢占，owner 仍可把自己的租约续回来。
    expect(
      store.renewProviderSession({
        agentId: "agent_a",
        providerSessionId: "prov_1",
        runId: "run_1",
        expiresAt: "2026-01-01T02:00:00.000Z",
      }),
    ).toBe(true);
    store.close();
  });

  it("refuses to renew once another run has claimed the expired provider session", () => {
    const store = new SqliteEventStore(":memory:");
    store.claimProviderSession({
      agentId: "agent_a",
      providerSessionId: "prov_1",
      runId: "run_1",
      now: T0,
      expiresAt: T1,
    });
    // T1 已过期，另一个 Run 抢占成功。
    expect(
      store.claimProviderSession({
        agentId: "agent_a",
        providerSessionId: "prov_1",
        runId: "run_2",
        now: "2026-01-01T00:06:00.000Z",
        expiresAt: "2026-01-01T01:00:00.000Z",
      }),
    ).toBe(true);
    // 原 owner 不能再把租约续回来，因为已经被别的 Run 拿走。
    expect(
      store.renewProviderSession({
        agentId: "agent_a",
        providerSessionId: "prov_1",
        runId: "run_1",
        expiresAt: "2026-01-01T02:00:00.000Z",
      }),
    ).toBe(false);
    store.close();
  });

  it("persists and reads the session_runtime provider_session_id", () => {
    const store = new SqliteEventStore(":memory:");
    store.withSessionTransaction((tx) => {
      tx.ensureRuntime("sess_1");
      tx.setSessionProviderSessionId("sess_1", "prov_1");
    });
    let read: string | null = null;
    store.withSessionTransaction((tx) => {
      read = tx.getSessionProviderSessionId("sess_1");
    });
    expect(read).toBe("prov_1");
    store.close();
  });
});
