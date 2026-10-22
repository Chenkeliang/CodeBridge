import { describe, expect, it } from "vitest";
import { parseTaskSchedule, previewTaskSchedule, nextTaskRun } from "./task-schedule.js";
const now = new Date("2026-10-15T00:00:00Z");
describe("Agent task schedule", () => {
  it("previews Chinese daily and weekday wall-clock schedules in their selected timezone", () => {
    expect(nextTaskRun(parseTaskSchedule("每天9点", "Asia/Shanghai", now), "Asia/Shanghai", now)).toBe("2026-10-15T01:00:00.000Z");
    expect(previewTaskSchedule(parseTaskSchedule("每天09:30", "Asia/Shanghai", now), "Asia/Shanghai", now)).toEqual(["2026-10-15T01:30:00.000Z", "2026-10-16T01:30:00.000Z", "2026-10-17T01:30:00.000Z"]);
    const friday = new Date("2026-10-16T02:00:00Z");
    expect(nextTaskRun(parseTaskSchedule("工作日09:00", "Asia/Shanghai", friday), "Asia/Shanghai", friday)).toBe("2026-10-19T01:00:00.000Z");
    expect(nextTaskRun(parseTaskSchedule("每周一09:00", "Asia/Shanghai", now), "Asia/Shanghai", now)).toBe("2026-10-19T01:00:00.000Z");
  });
  it("distinguishes an interval from a one-shot delay", () => {
    expect(parseTaskSchedule("每30分钟", "Asia/Shanghai", now)).toMatchObject({ kind: "interval", minutes: 30 });
    expect(parseTaskSchedule("every 2h", "Asia/Shanghai", now)).toMatchObject({ kind: "interval", minutes: 120 });
    expect(parseTaskSchedule("30分钟后", "Asia/Shanghai", now)).toMatchObject({ kind: "once", at: "2026-10-15T00:30:00.000Z" });
    expect(parseTaskSchedule("in 2h", "Asia/Shanghai", now)).toMatchObject({ kind: "once", at: "2026-10-15T02:00:00.000Z" });
  });
  it("uses explicit timezone for a naive one-shot timestamp", () => {
    expect(parseTaskSchedule("2026-10-15T09:00:00", "Asia/Shanghai", now)).toMatchObject({ kind: "once", at: "2026-10-15T01:00:00.000Z" });
  });
  it("uses the upstream calendar engine across daylight saving and invalid dates", () => {
    const start = new Date("2026-03-07T15:00:00Z"), s = parseTaskSchedule("0 9 * * *", "America/New_York", start);
    expect(previewTaskSchedule(s, "America/New_York", start)).toEqual(["2026-03-08T13:00:00.000Z", "2026-03-09T13:00:00.000Z", "2026-03-10T13:00:00.000Z"]);
    for (const text of ["每天25:00", "每0分钟", "每周八10点", "run whenever", "0 0 31 2 *"]) expect(() => parseTaskSchedule(text, "Asia/Shanghai", now)).toThrow();
    expect(() => parseTaskSchedule("每天09:00", "unknown/zone", now)).toThrow();
    expect(() => parseTaskSchedule("2020-01-01T09:00:00Z", "Asia/Shanghai", now)).toThrow();
  });
});
