import { describe, expect, it } from "vitest";
import * as acpRunner from "./acp/acp-session-runner.js";

type SteeringApi = {
  supportsAcpSteering?: (response: unknown) => boolean;
  steerAcpSession?: (
    agent: { request: (method: string, params: unknown) => Promise<unknown> },
    sessionId: string,
    prompt: string,
  ) => Promise<unknown>;
};

const api = acpRunner as unknown as SteeringApi;

describe("ACP steering extension", () => {
  it("gates steering from initialize _meta", () => {
    expect(
      api.supportsAcpSteering?.({
        _meta: { steering: { supported: true } },
      }),
    ).toBe(true);
    expect(api.supportsAcpSteering?.({ _meta: {} })).toBe(false);
  });

  it("sends _session/steering with ACP text content", async () => {
    expect(typeof api.steerAcpSession).toBe("function");
    const calls: Array<{ method: string; params: unknown }> = [];
    const response = { outcome: "injected" };
    const result = await api.steerAcpSession!(
      {
        request: async (method, params) => {
          calls.push({ method, params });
          return response;
        },
      },
      "s1",
      "focus on tests",
    );
    expect(calls).toEqual([
      {
        method: "_session/steering",
        params: {
          sessionId: "s1",
          prompt: [{ type: "text", text: "focus on tests" }],
        },
      },
    ]);
    expect(result).toBe(response);
  });
});
