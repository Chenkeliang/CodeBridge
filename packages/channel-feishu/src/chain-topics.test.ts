import { describe, expect, it } from "vitest";
import { ChainTopicTracker } from "./chain-topics.js";

describe("ChainTopicTracker", () => {
  it("群根消息（无 root）属于群级会话", () => {
    const t = new ChainTopicTracker();
    expect(t.resolve(undefined)).toBeUndefined();
  });

  it("回复陌生消息的串以串首为独立 topic", () => {
    const t = new ChainTopicTracker();
    expect(t.resolve("om_alert_1")).toBe("om_alert_1");
    expect(t.resolve("om_alert_2")).toBe("om_alert_2");
  });

  it("登记过的群根消息的回复串延续群级会话", () => {
    const t = new ChainTopicTracker();
    t.recordGroupRoot("om_user_msg");
    expect(t.resolve("om_user_msg")).toBeUndefined();
  });

  it("超出容量时淘汰最早登记的串首", () => {
    const t = new ChainTopicTracker(2);
    t.recordGroupRoot("om_1");
    t.recordGroupRoot("om_2");
    t.recordGroupRoot("om_3");
    // om_1 被淘汰，回复它的串按新话题处理
    expect(t.resolve("om_1")).toBe("om_1");
    expect(t.resolve("om_2")).toBeUndefined();
    expect(t.resolve("om_3")).toBeUndefined();
  });
});
