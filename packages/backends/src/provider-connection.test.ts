import { afterEach, describe, expect, it, vi } from "vitest";
import { testProviderConnection } from "./provider-connection.js";

describe("testProviderConnection", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => handler(String(url), init)));
  }

  it("probes the Responses endpoint when the provider uses openai-responses", async () => {
    mockFetch((url) => url.endsWith("/models")
      ? Response.json({ data: [] })
      : Response.json({ error: "unsupported" }, { status: 404 }));

    const result = await testProviderConnection({
      baseUrl: "https://llm.example.com/v1",
      apiKey: "sk-test",
      authHeader: true,
      api: "openai-responses",
      model: "deepseek-v4-pro",
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Responses API 不可用");
    expect(result.detail).toContain("unsupported");
  });

  it("reports protocol unverified when a responses provider has no model", async () => {
    mockFetch(() => Response.json({ data: [] }));

    const result = await testProviderConnection({
      baseUrl: "https://llm.example.com/v1",
      api: "openai-responses",
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("协议未验证");
  });

  it("probes /chat/completions for openai-completions providers", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/models") ? Response.json({ data: [] }) : Response.json({ choices: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testProviderConnection({
      baseUrl: "https://api.deepseek.com/v1",
      api: "openai-completions",
      model: "deepseek-chat",
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("Chat Completions API 可用");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/chat/completions");
  });

  it("detects developer-role rejection and suggests the compat fix", async () => {
    mockFetch((url, init) => {
      if (url.endsWith("/models")) return Response.json({ data: [] });
      const body = JSON.parse(String(init?.body));
      if (body.messages[0].role === "developer") {
        return Response.json({ message: "messages[0].role: unknown variant `developer`" }, { status: 400 });
      }
      return Response.json({ choices: [] });
    });

    const result = await testProviderConnection({
      baseUrl: "https://llm.example.com/v1",
      api: "openai-completions",
      model: "deepseek-v4-pro",
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("developer");
    expect(result.compatSuggestion).toEqual({ supportsDeveloperRole: false });
  });

  it("probes /messages with the anthropic-version header for anthropic-messages providers", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [] });
      const headers = init?.headers as Record<string, string>;
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      return Response.json({ error: { message: "model not found" } }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await testProviderConnection({
      baseUrl: "https://api.anthropic.com/v1",
      api: "anthropic-messages",
      model: "claude-sonnet-4-5",
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Messages API 不可用");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/messages");
  });
});
