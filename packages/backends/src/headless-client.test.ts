import { describe, expect, it } from "vitest";
import type {
  PermissionOption,
  RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import { pickAllowOption } from "./acp/headless-client.js";

function makeRequest(
  options: PermissionOption[],
): RequestPermissionRequest {
  return {
    sessionId: "sess-1",
    toolCall: { toolCallId: "call-1" },
    options,
  } as unknown as RequestPermissionRequest;
}

describe("pickAllowOption", () => {
  it("picks allow_once over allow_always regardless of order", () => {
    const result = pickAllowOption(
      makeRequest([
        { optionId: "always", name: "Always Allow", kind: "allow_always" },
        { optionId: "once", name: "Allow Once", kind: "allow_once" },
      ]),
    );

    expect(result).toEqual({
      outcome: { outcome: "selected", optionId: "once" },
    });
  });

  it("picks allow_always when no allow_once option exists", () => {
    const result = pickAllowOption(
      makeRequest([
        { optionId: "reject", name: "Reject", kind: "reject_once" },
        { optionId: "always", name: "Always Allow", kind: "allow_always" },
      ]),
    );

    expect(result).toEqual({
      outcome: { outcome: "selected", optionId: "always" },
    });
  });

  it("returns cancelled when only reject options are present", () => {
    const result = pickAllowOption(
      makeRequest([
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        {
          optionId: "reject-always",
          name: "Always Reject",
          kind: "reject_always",
        },
      ]),
    );

    expect(result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("returns cancelled for empty options", () => {
    const result = pickAllowOption(makeRequest([]));

    expect(result).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
