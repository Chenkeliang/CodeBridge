import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workbench API client", () => {
  it("can request archived Sessions for the archive view", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ sessions: [] }));
    vi.stubGlobal("fetch", fetch);

    await api.sessions(false, true);

    expect(fetch).toHaveBeenCalledWith("/v1/sessions?include_archived=true", expect.any(Object));
  });

  it("hydrates a Session before loading its conversation resources", async () => {
    let resolveSession!: (response: Response) => void;
    const sessionResponse = new Promise<Response>((resolve) => { resolveSession = resolve; });
    const fetch = vi.fn((url: string) => {
      if (url === "/v1/sessions/session-1") return sessionResponse;
      if (url.includes("/events")) return Promise.resolve(new Response(""));
      if (url.includes("/commands")) return Promise.resolve(Response.json({ commands: [] }));
      if (url.includes("/config-options")) return Promise.resolve(Response.json({ options: [] }));
      if (url.includes("/runs")) return Promise.resolve(Response.json({ runs: [] }));
      return Promise.reject(new Error(`unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetch);

    const openSession = (api as unknown as { openSession?: (id: string) => Promise<unknown> }).openSession;
    expect(openSession).toBeTypeOf("function");
    if (!openSession) return;

    const pending = openSession("session-1");
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveSession(Response.json({ session_id: "session-1", agent_id: "codex" }));
    await pending;

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/v1/sessions/session-1",
      "/v1/sessions/session-1/events?after_sequence=0",
      "/v1/sessions/session-1/commands",
      "/v1/sessions/session-1/config-options",
      "/v1/sessions/session-1/runs",
    ]);
  });

  it("sends the concrete approval id when approving a Run", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "granted" }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }));
    vi.stubGlobal("fetch", fetch);

    await api.approve("run-1", "approval-1");

    expect(fetch).toHaveBeenCalledWith("/v1/runs/run-1/approve", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ approval_id: "approval-1" }),
    }));
  });

  it("uses the Runner directory picker for an existing Session", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session_id: "session-1",
      additional_directories: ["/workspace/project"],
    }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }));
    vi.stubGlobal("fetch", fetch);

    await api.pickDirectory("session-1");

    expect(fetch).toHaveBeenCalledWith("/v1/sessions/session-1/directories/pick", expect.objectContaining({
      method: "POST",
    }));
  });

  it("includes selected files when sending a Session message", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sequence: 1 }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }));
    vi.stubGlobal("fetch", fetch);

    await api.sendMessage("session-1", "review this", null, null, [{
      name: "screen.png",
      mimeType: "image/png",
      dataBase64: "aW1hZ2U=",
    }], "read-only");

    expect(fetch).toHaveBeenCalledWith("/v1/sessions/session-1/messages", expect.objectContaining({
      body: JSON.stringify({
        message: "review this",
        flow_id: null,
        model: null,
        permission_mode: "read-only",
        attachments: [{ name: "screen.png", mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
      }),
    }));
  });
});
