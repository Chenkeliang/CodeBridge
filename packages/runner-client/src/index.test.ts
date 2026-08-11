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

describe("RunnerClient session history", () => {
  it("loads provider history with the Session workspace", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events: [{ kind: "message", text: "hello" }] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new RunnerClient({ baseUrl: "http://runner", token: "token" });

    await expect(client.loadSessionHistory("claude", "/workspace", "session-1")).resolves.toEqual([
      { kind: "message", text: "hello" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://runner/sessions/session-1/history?backend=claude&cwd=%2Fworkspace",
      expect.any(Object),
    );
  });

  it("aborts a provider history request at its deadline", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const options = {
      baseUrl: "http://runner",
      token: "token",
      sessionHistoryTimeoutMs: 5,
    };
    const client = new RunnerClient(options);

    const outcome = await Promise.race([
      client.loadSessionHistory("claude", "/workspace", "session-1")
        .then(() => "resolved", (error: Error) => error.name),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 50)),
    ]);

    expect(outcome).toBe("AbortError");
  });
});

describe("RunnerClient cancellation", () => {
  it("cancels the remote Runner task when an active stream is aborted", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((url: string) => {
      if (url === "http://runner/runs") {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(new TextEncoder().encode(": keepalive\n\n"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      if (url === "http://runner/runs/r1/cancel") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      return Promise.reject(new Error(`unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new RunnerClient({ baseUrl: "http://runner", token: "token" });
    const consuming = (async () => {
      for await (const _event of client.run(
        {
          runId: "r1",
          sessionKey: { chatId: "chat", backendId: "codex", cwd: "/workspace" },
          prompt: "wait",
        },
        { signal: controller.signal },
      )) {
        // The stream only contains keepalives.
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await consuming;

    expect(fetchMock).toHaveBeenCalledWith(
      "http://runner/runs/r1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("cancels the remote task when aborted before the run response arrives", async () => {
    const controller = new AbortController();
    let markRunStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "http://runner/runs") {
        markRunStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
      }
      if (url === "http://runner/runs/r1/cancel") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      return Promise.reject(new Error(`unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new RunnerClient({ baseUrl: "http://runner", token: "token" });
    const consuming = (async () => {
      for await (const _event of client.run(
        {
          runId: "r1",
          sessionKey: { chatId: "chat", backendId: "codex", cwd: "/workspace" },
          prompt: "wait",
        },
        { signal: controller.signal },
      )) {
        // The run response never arrives before cancellation.
      }
    })();

    await runStarted;
    controller.abort();
    await consuming;

    expect(fetchMock).toHaveBeenCalledWith(
      "http://runner/runs/r1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects when Runner does not acknowledge cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false }), { status: 409 }),
      ),
    );
    const client = new RunnerClient({ baseUrl: "http://runner", token: "token" });

    await expect(client.cancel("r1")).rejects.toThrow("Runner cancellation failed");
  });

  it("classifies a cancellation network failure as a cancellation error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("socket closed")));
    const client = new RunnerClient({ baseUrl: "http://runner", token: "token" });

    await expect(client.cancel("r1")).rejects.toMatchObject({
      name: "RunnerCancellationError",
      message: expect.stringContaining("socket closed"),
    });
  });
});

describe("RunnerClient session lifecycle", () => {
  it("forks a provider session into a target directory", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, sessionId: "pi-fork", cwd: "/target" }), {
        status: 201,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new RunnerClient({ baseUrl: "http://runner", token: "token" });

    await expect(client.forkSession("pi", "/source", "s1", "/target")).resolves.toEqual({
      ok: true,
      sessionId: "pi-fork",
      cwd: "/target",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://runner/sessions/s1/fork",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ backend: "pi", cwd: "/source", targetCwd: "/target" }),
      }),
    );
  });

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
  it("lists an authorized workspace directory through Runner", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      root: "/workspace",
      path: "/workspace/src",
      entries: [{ name: "index.ts", path: "src/index.ts", absolutePath: "/workspace/src/index.ts", kind: "file" }],
    })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new RunnerClient({ baseUrl: "http://runner", token: "token" });
    const listDirectory = (client as unknown as {
      listDirectory?: (root: string, relativePath?: string) => Promise<unknown>;
    }).listDirectory;

    expect(listDirectory).toBeTypeOf("function");
    if (!listDirectory) return;
    await expect(listDirectory.call(client, "/workspace", "src")).resolves.toMatchObject({
      ok: true,
      path: "/workspace/src",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://runner/directories/list?root=%2Fworkspace&path=src",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("picks a directory through the Runner host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, path: "/Users/tester/Projects/app" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new RunnerClient({ baseUrl: "http://runner", token: "token" });

    await expect(client.pickDirectory()).resolves.toEqual({
      ok: true,
      path: "/Users/tester/Projects/app",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://runner/directories/pick",
      expect.objectContaining({ method: "POST" }),
    );
  });

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

describe("RunnerClient Agent commands", () => {
  it("loads commands for the selected backend and workspace", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ commands: [{ name: "skill:review", description: "Review" }] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new RunnerClient({ baseUrl: "http://runner", token: "token" });

    await expect(client.listCommands("pi", "/workspace")).resolves.toEqual({
      commands: [{ name: "skill:review", description: "Review" }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://runner/commands?backend=pi&cwd=%2Fworkspace",
      expect.any(Object),
    );
  });
});
