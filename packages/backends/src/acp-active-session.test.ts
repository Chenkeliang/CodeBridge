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

  it("passes additionalDirectories when creating a supported session", async () => {
    const active = { sessionId: "sess-new", dispose: () => {} };
    let request: unknown;
    const agent = {
      buildSession: (value: unknown) => {
        request = value;
        return { start: async () => active };
      },
    };
    const profile = defaultConfig().backends.claude!;
    await openActiveSession(
      { agent } as unknown as ClientConnection,
      {
        runId: "r1",
        cwd: "/tmp/project",
        additionalDirectories: ["/tmp/shared"],
        prompt: "hi",
        backendConfig: profile,
      },
      profile,
      { supportsAdditionalDirectories: true },
    );
    expect(request).toEqual({
      cwd: "/tmp/project",
      additionalDirectories: ["/tmp/shared"],
      mcpServers: [],
    });
  });

  it("rejects requested additionalDirectories when the agent did not advertise support", async () => {
    const profile = defaultConfig().backends.cursor!;
    await expect(
      openActiveSession(
        { agent: {} } as unknown as ClientConnection,
        {
          runId: "r1",
          cwd: "/tmp/project",
          additionalDirectories: ["/tmp/shared"],
          prompt: "hi",
          backendConfig: profile,
        },
        profile,
      ),
    ).rejects.toThrow(/additionalDirectories/);
  });

  it("attaches ActiveSession after session/load", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const active = { sessionId: "sess-loaded", dispose: () => {} };
    const agent = {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
      },
      attachSession: () => {
        calls.push({ method: "attachSession" });
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
        additionalDirectories: ["/tmp/shared"],
        backendConfig: profile,
      },
      profile,
      { supportsAdditionalDirectories: true },
    );

    expect(calls).toEqual([
      {
        method: "session/load",
        params: {
          sessionId: "sess-loaded",
          cwd: "/tmp",
          additionalDirectories: ["/tmp/shared"],
          mcpServers: [],
        },
      },
      { method: "attachSession" },
    ]);
    expect(result).toBe(active);
  });

  it("fails without creating a replacement session when session/load times out", async () => {
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
        { loadTimeoutMs: 30 },
      ),
    ).rejects.toThrow("ACP session 续聊超时");
    expect(buildCalls).toBe(0);
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
