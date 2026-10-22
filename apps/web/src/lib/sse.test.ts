import { describe, expect, it } from "vitest";
import { parseSseFrames } from "./sse";

describe("SSE frame parsing", () => {
  it("keeps an incomplete frame for the next network chunk", () => {
    const result = parseSseFrames('id: 1\ndata: {"sequence":1}\n\nid: 2\ndata: {"sequence"');

    expect(result.events).toEqual([{ sequence: 1 }]);
    expect(result.remainder).toBe('id: 2\ndata: {"sequence"');
  });
});
