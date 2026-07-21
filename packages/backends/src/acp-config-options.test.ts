import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { RunContext } from "@feishu-code-bridge/core";
import {
  applySessionConfigOptions,
  mapSessionConfigOptions,
  matchConfigValue,
  resolveDesiredConfig,
} from "./acp/acp-config-options.js";

const modelOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "claude-fable-5[1m]",
  options: [
    { value: "default", name: "Default (recommended)" },
    { value: "opus[1m]", name: "Opus" },
    { value: "claude-fable-5[1m]", name: "Fable" },
    { value: "sonnet", name: "Sonnet" },
    { value: "haiku", name: "Haiku" },
  ],
} as unknown as SessionConfigOption;

const effortOption = {
  id: "effort",
  name: "Effort",
  category: "thought_level",
  type: "select",
  currentValue: "xhigh",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
} as unknown as SessionConfigOption;

const modeOption = {
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue: "dontAsk",
  options: [
    { value: "default", name: "Default" },
    { value: "dontAsk", name: "Don't Ask" },
    { value: "bypassPermissions", name: "Bypass Permissions" },
  ],
} as unknown as SessionConfigOption;

const ctx = (over: Partial<RunContext>): RunContext =>
  ({
    runId: "r",
    cwd: "/x",
    prompt: "p",
    backendConfig: { type: "claude-code" },
    ...over,
  }) as unknown as RunContext;

function fakeAgent() {
  const calls: Array<{ method: unknown; params: Record<string, unknown> }> = [];
  const agent = {
    request: async (method: unknown, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { configOptions: [] };
    },
  } as unknown as Parameters<typeof applySessionConfigOptions>[0];
  return { agent, calls };
}

describe("matchConfigValue", () => {
  it("精确 value 命中", () => {
    expect(matchConfigValue(modelOption, "sonnet")).toBe("sonnet");
    expect(matchConfigValue(modelOption, "default")).toBe("default");
  });
  it("大小写不敏感 name 命中", () => {
    expect(matchConfigValue(modelOption, "Sonnet")).toBe("sonnet");
  });
  it("value 前缀把 opus 映射到 opus[1m]", () => {
    expect(matchConfigValue(modelOption, "opus")).toBe("opus[1m]");
  });
  it("匹配不到返回 undefined", () => {
    expect(matchConfigValue(modelOption, "gpt-5")).toBeUndefined();
  });
  it("展平分组选项", () => {
    const grouped = {
      id: "model",
      category: "model",
      type: "select",
      currentValue: "a",
      options: [
        {
          group: "g1",
          name: "Group 1",
          options: [
            { value: "a", name: "A" },
            { value: "b", name: "B" },
          ],
        },
      ],
    } as unknown as SessionConfigOption;
    expect(matchConfigValue(grouped, "b")).toBe("b");
  });
});

describe("resolveDesiredConfig", () => {
  it("ctx.model 优先，其次 backendConfig.model", () => {
    expect(
      resolveDesiredConfig(
        ctx({
          model: "sonnet",
          backendConfig: { type: "claude-code", model: "opus" } as never,
        }),
        "auto_allow",
      ).model,
    ).toBe("sonnet");
    expect(
      resolveDesiredConfig(
        ctx({ backendConfig: { type: "claude-code", model: "opus" } as never }),
        "auto_allow",
      ).model,
    ).toBe("opus");
  });

  it("effort 同样 ctx 优先", () => {
    expect(
      resolveDesiredConfig(ctx({ effort: "high" }), "auto_allow").effort,
    ).toBe("high");
  });

  it("permission：显式优先", () => {
    expect(
      resolveDesiredConfig(
        ctx({ claudePermissionMode: "plan" }),
        "auto_allow",
      ).permissionMode,
    ).toBe("plan");
  });

  it("permission 无显式：auto_allow→bypassPermissions，prompt_deny/prompt_feishu→default", () => {
    expect(resolveDesiredConfig(ctx({}), "auto_allow").permissionMode).toBe(
      "bypassPermissions",
    );
    expect(resolveDesiredConfig(ctx({}), "prompt_deny").permissionMode).toBe(
      "default",
    );
    // prompt_feishu 必须让适配器真的发问，否则 /approve 流程永远触发不了
    expect(resolveDesiredConfig(ctx({}), "prompt_feishu").permissionMode).toBe(
      "default",
    );
  });

  it("非 claude 后端不设 permissionMode", () => {
    expect(
      resolveDesiredConfig(
        ctx({ backendConfig: { type: "cursor-cli" } as never }),
        "auto_allow",
      ).permissionMode,
    ).toBeUndefined();
  });
});

describe("applySessionConfigOptions", () => {
  const options = [modelOption, effortOption, modeOption];

  it("按 category 发出正确的 set_config_option，无 warning", async () => {
    const { agent, calls } = fakeAgent();
    const { warnings } = await applySessionConfigOptions(agent, "s1", options, {
      model: "sonnet",
      effort: "medium",
      permissionMode: "bypassPermissions",
    });
    expect(warnings).toEqual([]);
    expect(calls.map((c) => c.params)).toEqual([
      { sessionId: "s1", configId: "model", value: "sonnet" },
      { sessionId: "s1", configId: "effort", value: "medium" },
      { sessionId: "s1", configId: "mode", value: "bypassPermissions" },
    ]);
  });

  it("未设的字段不发调用", async () => {
    const { agent, calls } = fakeAgent();
    await applySessionConfigOptions(agent, "s1", options, { model: "haiku" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params.value).toBe("haiku");
  });

  it("缺失 category 收 warning、不中断", async () => {
    const { agent, calls } = fakeAgent();
    const { warnings } = await applySessionConfigOptions(
      agent,
      "s1",
      [modelOption], // 无 thought_level
      { model: "sonnet", effort: "medium" },
    );
    expect(calls).toHaveLength(1); // 仅 model
    expect(warnings.some((w) => w.includes("effort"))).toBe(true);
  });

  it("值不在可选范围收 warning", async () => {
    const { agent } = fakeAgent();
    const { warnings } = await applySessionConfigOptions(agent, "s1", options, {
      model: "gpt-5",
    });
    expect(warnings.some((w) => w.includes("gpt-5"))).toBe(true);
  });

  it("set 抛错收 warning、不抛出", async () => {
    const calls: unknown[] = [];
    const agent = {
      request: async () => {
        calls.push(1);
        throw new Error("boom");
      },
    } as unknown as Parameters<typeof applySessionConfigOptions>[0];
    const { warnings } = await applySessionConfigOptions(agent, "s1", options, {
      model: "sonnet",
    });
    expect(warnings.some((w) => w.includes("失败"))).toBe(true);
  });
});

describe("mapSessionConfigOptions", () => {
  it("映射 select 选项为共享精简形态（含 currentValue/描述）", () => {
    const mapped = mapSessionConfigOptions([modelOption, effortOption]);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({
      id: "model",
      category: "model",
      currentValue: "claude-fable-5[1m]",
    });
    expect(mapped[0]!.values.map((v) => v.value)).toContain("sonnet");
  });

  it("展平分组 select", () => {
    const grouped = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "a",
      options: [
        {
          group: "g1",
          name: "Group 1",
          options: [
            { value: "a", name: "A" },
            { value: "b", name: "B", description: "desc-b" },
          ],
        },
      ],
    } as unknown as Parameters<typeof mapSessionConfigOptions>[0][number];
    const mapped = mapSessionConfigOptions([grouped]);
    expect(mapped[0]!.values).toEqual([
      { value: "a", name: "A", description: undefined },
      { value: "b", name: "B", description: "desc-b" },
    ]);
  });

  it("跳过 boolean 型选项", () => {
    const bool = {
      id: "x",
      name: "X",
      type: "boolean",
      currentValue: true,
    } as unknown as Parameters<typeof mapSessionConfigOptions>[0][number];
    expect(mapSessionConfigOptions([bool])).toEqual([]);
  });
});
