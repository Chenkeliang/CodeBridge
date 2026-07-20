import { describe, expect, it } from "vitest";
import type { BackendConfigOption } from "@feishu-code-bridge/core";
import { formatDynamicModelHelp } from "./model-effort.js";

const claudeModelOption: BackendConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  currentValue: "claude-fable-5[1m]",
  values: [
    { value: "claude-fable-5[1m]", name: "Fable" },
    {
      value: "sonnet",
      name: "Sonnet",
      description: "Efficient for routine tasks.",
    },
  ],
};

describe("formatDynamicModelHelp", () => {
  it("列出真实值、标注适配器默认与描述", () => {
    const text = formatDynamicModelHelp(
      "claude",
      claudeModelOption,
      "sonnet",
    );
    expect(text).toContain("适配器实时列表");
    // name 与 value 真正不同时展示别名，并标注适配器默认
    expect(text).toContain("`claude-fable-5[1m]` — Fable（适配器默认）");
    // name 与 value 只差大小写时不重复展示别名
    expect(text).toContain("- `sonnet`：Efficient for routine tasks.");
    expect(text).not.toContain("`sonnet` — Sonnet");
    expect(text).toContain("当前会话: `sonnet`");
  });

  it("无当前会话覆盖时不渲染当前会话行", () => {
    const text = formatDynamicModelHelp("claude", claudeModelOption);
    expect(text).not.toContain("当前会话");
    expect(text).toContain("/model default");
  });
});
