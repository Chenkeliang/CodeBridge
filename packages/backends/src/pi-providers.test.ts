import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PI_PROVIDER_PRESETS,
  readPiProviders,
  validateProviders,
  writePiProviders,
  type PiProvidersFile,
} from "./pi-providers.js";

function validFile(): PiProvidersFile {
  return {
    providers: {
      deepseek: {
        baseUrl: "https://api.deepseek.com/v1",
        api: "openai-completions",
        apiKey: "sk-test",
        models: [
          { id: "deepseek-chat", reasoning: false, input: ["text"] },
          {
            id: "deepseek-reasoner",
            reasoning: true,
            thinkingLevelMap: { off: null, low: "low", high: "high" },
            input: ["text"],
          },
        ],
      },
    },
  };
}

describe("pi providers", () => {
  let dir: string;
  let modelsPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-providers-"));
    modelsPath = path.join(dir, "models.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads an empty file as no providers", () => {
    expect(readPiProviders(modelsPath)).toEqual({ providers: {} });
  });

  it("round-trips a validated providers file and leaves a backup", () => {
    writePiProviders(validFile(), modelsPath);
    writePiProviders(validFile(), modelsPath);
    expect(fs.existsSync(`${modelsPath}.bak`)).toBe(true);
    expect(readPiProviders(modelsPath).providers.deepseek?.models).toHaveLength(2);
  });

  it("rejects invalid providers with field-level issues", () => {
    const bad = validFile();
    bad.providers["Bad ID"] = { baseUrl: "not-a-url", api: "", models: [] };
    const issues = validateProviders(bad);
    expect(issues.some((issue) => issue.includes("provider id 不合法"))).toBe(true);
    expect(issues.some((issue) => issue.includes("baseUrl"))).toBe(true);
    expect(() => writePiProviders(bad, modelsPath)).toThrow();
    expect(fs.existsSync(modelsPath)).toBe(false);
  });

  it("requires a usable thinkingLevelMap when reasoning is true", () => {
    const bad = validFile();
    bad.providers.deepseek!.models[1]!.thinkingLevelMap = { off: null, low: null };
    expect(validateProviders(bad).some((issue) => issue.includes("thinkingLevelMap"))).toBe(true);
  });

  it("ships presets without credentials and with valid templates", () => {
    expect(PI_PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const preset of PI_PROVIDER_PRESETS) {
      expect(JSON.stringify(preset)).not.toMatch(/sk-/);
      const file: PiProvidersFile = {
        providers: {
          [preset.id]: {
            baseUrl: preset.baseUrl,
            api: preset.api,
            models: preset.models,
          },
        },
      };
      expect(validateProviders(file)).toEqual([]);
    }
  });
});

describe("model-driven thinking levels", () => {
  it("returns no levels for non-reasoning models", async () => {
    const { piThinkingLevelsForModel } = await import("./pi-session-runner.js");
    expect(piThinkingLevelsForModel({ reasoning: false })).toEqual([]);
  });

  it("restricts levels to the model thinkingLevelMap in canonical order", async () => {
    const { piThinkingLevelsForModel } = await import("./pi-session-runner.js");
    expect(piThinkingLevelsForModel({ reasoning: true, thinkingLevelMap: { high: "high", off: null, low: "low" } })).toEqual(["low", "high"]);
  });

  it("falls back to all levels for reasoning models without a map or unknown selection", async () => {
    const { piThinkingLevelsForModel } = await import("./pi-session-runner.js");
    expect(piThinkingLevelsForModel({ reasoning: true })).toHaveLength(7);
    expect(piThinkingLevelsForModel(null)).toHaveLength(7);
  });

  it("omits the thought_level option for non-reasoning models", async () => {
    const { listPiConfigOptions } = await import("./pi-session-runner.js");
    const models = [
      { provider: "deepseek", id: "deepseek-chat", name: "Chat", api: "openai-completions", reasoning: false },
      { provider: "deepseek", id: "deepseek-reasoner", name: "Reasoner", api: "openai-completions", reasoning: true, thinkingLevelMap: { off: null, low: "low", high: "high" } },
    ];
    const runtime = {
      getModels: () => models,
      hasConfiguredAuth: () => true,
      getModel: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    };
    const forChat = await listPiConfigOptions(runtime, "deepseek/deepseek-chat");
    expect(forChat.find((o) => o.category === "thought_level")).toBeUndefined();
    const forReasoner = await listPiConfigOptions(runtime, "deepseek/deepseek-reasoner");
    const levels = forReasoner.find((o) => o.category === "thought_level");
    expect(levels?.values.map((v) => v.value)).toEqual(["low", "high"]);
  });
});
