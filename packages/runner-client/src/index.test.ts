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
