import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerClient } from "./index.js";

afterEach(() => vi.unstubAllGlobals());

describe("RunnerClient steering", () => {
  it("posts a steering prompt to the active run", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, outcome: "injected" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new RunnerClient({
      baseUrl: "http://runner",
      token: "token",
    });

    await expect(client.steer("r1", "focus on tests")).resolves.toEqual({
      ok: true,
      outcome: "injected",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://runner/runs/r1/steer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt: "focus on tests" }),
      }),
    );
  });
});

describe("RunnerClient session lifecycle", () => {
  it("posts close for an explicit session id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new RunnerClient({ baseUrl: "http://runner", token: "token" });

    await expect(client.closeSession("claude", "/workspace", "s1")).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://runner/sessions/s1/close",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ backend: "claude", cwd: "/workspace" }),
      }),
    );
  });

  it("deletes a session and surfaces runner errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "unsupported" }), {
        status: 409,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new RunnerClient({ baseUrl: "http://runner", token: "token" });

    await expect(client.deleteSession("claude", "/workspace", "s1")).resolves.toEqual({
      ok: false,
      error: "unsupported",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://runner/sessions/s1",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ backend: "claude", cwd: "/workspace" }),
      }),
    );
  });
});

describe("RunnerClient directory authorization", () => {
  it("asks Runner to access an absolute directory", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, path: "/Users/tester/Desktop" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new RunnerClient({ baseUrl: "http://runner", token: "token" });

    await expect(client.authorizeDirectory("/Users/tester/Desktop")).resolves.toEqual({
      ok: true,
      path: "/Users/tester/Desktop",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://runner/directories/authorize",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: "/Users/tester/Desktop" }),
      }),
    );
  });

  it("returns a clear timeout result when macOS authorization does not finish", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) return Promise.reject(new Error("missing timeout signal"));
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new RunnerClient({
      baseUrl: "http://runner",
      token: "token",
      directoryAuthorizationTimeoutMs: 5,
    });

    await expect(
      client.authorizeDirectory("/Users/tester/Desktop"),
    ).resolves.toEqual({
      ok: false,
      path: "/Users/tester/Desktop",
      error: expect.stringContaining("超时"),
    });
  });
});
