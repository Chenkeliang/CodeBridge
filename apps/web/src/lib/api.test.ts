import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workbench API client", () => {
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
    }]);

    expect(fetch).toHaveBeenCalledWith("/v1/sessions/session-1/messages", expect.objectContaining({
      body: JSON.stringify({
        message: "review this",
        flow_id: null,
        model: null,
        attachments: [{ name: "screen.png", mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
      }),
    }));
  });
});
