import { describe, expect, it } from "vitest";
import type { ClientConnection } from "@agentclientprotocol/sdk";
import { openActiveSession } from "./acp/acp-active-session.js";
import { AcpTimeoutError, raceWithAbort } from "./acp/acp-race.js";
import { defaultConfig } from "@feishu-code-bridge/core";

describe("raceWithAbort", () => {
  it("throws AcpTimeoutError when promise never settles", async () => {
    await expect(
      raceWithAbort(
        new Promise<string>(() => {}),
        () => false,
        50,
        "timed out",
      ),
    ).rejects.toBeInstanceOf(AcpTimeoutError);
  });
});

describe("openActiveSession", () => {
  it("starts a new ActiveSession when no resume id", async () => {
    const active = { sessionId: "sess-new", dispose: () => {} };
    const agent = {
      buildSession: () => ({
        start: async () => active,
      }),
    };
    const connection = { agent } as unknown as ClientConnection;

    const result = await openActiveSession(
      connection,
      {
        runId: "r1",
        cwd: "/tmp",
        prompt: "hi",
        backendConfig: defaultConfig().backends.cursor!,
      },
      defaultConfig().backends.cursor!,
    );

    expect(result).toBe(active);
  });

  it("attaches ActiveSession after session/load", async () => {
    const calls: string[] = [];
    const active = { sessionId: "sess-loaded", dispose: () => {} };
    const agent = {
      request: async (method: string) => {
        calls.push(method);
      },
      attachSession: () => {
        calls.push("attachSession");
        return active;
      },
      buildSession: () => ({
        start: async () => ({ sessionId: "fallback" }),
      }),
    };
    const connection = { agent } as unknown as ClientConnection;
    const profile = defaultConfig().backends.cursor!;

    const result = await openActiveSession(
      connection,
      {
        runId: "r1",
        cwd: "/tmp",
        prompt: "hi",
        resumeSessionId: "sess-loaded",
        backendConfig: profile,
      },
      profile,
    );

    expect(calls).toEqual(["session/load", "attachSession"]);
    expect(result).toBe(active);
  });

  it("falls back to new session when session/load times out", async () => {
    const fallback = { sessionId: "fresh", dispose: () => {} };
    const agent = {
      request: () => new Promise<void>(() => {}),
      attachSession: () => {
        throw new Error("should not attach");
      },
      buildSession: () => ({
        start: async () => fallback,
      }),
    };
    const connection = { agent } as unknown as ClientConnection;
    const profile = defaultConfig().backends.cursor!;

    const result = await openActiveSession(
      connection,
      {
        runId: "r1",
        cwd: "/tmp",
        prompt: "hi",
        resumeSessionId: "stale",
        backendConfig: profile,
      },
      profile,
      { loadTimeoutMs: 30 },
    );

    expect(result).toBe(fallback);
  });

  it("times out instead of hanging when session/new never settles", async () => {
    const agent = {
      buildSession: () => ({
        start: () => new Promise<never>(() => {}),
      }),
    };
    const connection = { agent } as unknown as ClientConnection;

    await expect(
      openActiveSession(
        connection,
        {
          runId: "r1",
          cwd: "/tmp",
          prompt: "hi",
          backendConfig: defaultConfig().backends.cursor!,
        },
        defaultConfig().backends.cursor!,
        { loadTimeoutMs: 30 },
      ),
    ).rejects.toBeInstanceOf(AcpTimeoutError);
  });

  it("does not fall back to a new session when aborted during load", async () => {
    let buildCalls = 0;
    const agent = {
      request: () => new Promise<void>(() => {}),
      attachSession: () => {
        throw new Error("should not attach");
      },
      buildSession: () => {
        buildCalls += 1;
        return { start: async () => ({ sessionId: "fresh" }) };
      },
    };
    const connection = { agent } as unknown as ClientConnection;
    const profile = defaultConfig().backends.cursor!;

    await expect(
      openActiveSession(
        connection,
        {
          runId: "r1",
          cwd: "/tmp",
          prompt: "hi",
          resumeSessionId: "stale",
          backendConfig: profile,
        },
        profile,
        { isAborted: () => true, loadTimeoutMs: 100 },
      ),
    ).rejects.toThrow("aborted");
    expect(buildCalls).toBe(0);
  });
});
