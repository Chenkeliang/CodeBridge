import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkVersions, stageRelease } from "./package-release.mjs";

const temporary: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-pack-test-"));
  temporary.push(root);
  fs.mkdirSync(path.join(root, "apps"));
  fs.mkdirSync(path.join(root, "packages"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "codebridge", version: "0.1.0", private: true, license: "MIT", engines: { node: ">=22.19.0" } }));
  for (const file of ["README.md", "README.zh-CN.md", "LICENSE", "CHANGELOG.md", "docs/zh-CN/npm-release.md", "apps/web/public/brand/agent-logo.svg", "apps/web/public/brand/agent-logo-carbon.svg"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file);
  }
  fs.writeFileSync(path.join(root, "README.md"), '<img src="apps/web/public/brand/agent-logo.svg"><source srcset="apps/web/public/brand/agent-logo-carbon.svg">[安装](docs/zh-CN/npm-release.md)');
  for (const [group, name] of [["apps", "bridge"], ["apps", "web"], ["packages", "core"]]) {
    const dir = path.join(root, group!, name!);
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: `@codebridge/${name}`, version: "0.1.0", type: "module", exports: { ".": "./dist/index.js" },
      scripts: { install: "should-not-run" }, devDependencies: { typescript: "*" },
      dependencies: name === "core" ? { yaml: "^2.6.1" } : { "@codebridge/core": "workspace:*", react: "^19.0.0" },
    }));
    for (const file of ["index.js", "index.d.ts", "index.js.map", "index.test.js", "index.test.d.ts"]) fs.writeFileSync(path.join(dir, "dist", file), "export {};");
    for (const [dependency, version] of [["yaml", "2.9.0"], ["react", "19.2.0"]]) {
      fs.mkdirSync(path.join(dir, "node_modules", dependency!), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", dependency!, "package.json"), JSON.stringify({ name: dependency, version }));
    }
    fs.writeFileSync(path.join(dir, "config.yaml"), "secret: do-not-ship");
  }
  fs.writeFileSync(path.join(root, ".env"), "DO_NOT_SHIP=secret");
  return root;
}
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("npm distribution", () => {
  it("packages only compiled modules and metadata, preserving workspace imports without publishing internal packages", () => {
    const root = fixture();
    const stage = path.join(root, "output");
    const manifest = stageRelease(root, stage);
    expect(manifest.bundleDependencies).toEqual(["@codebridge/bridge", "@codebridge/core", "@codebridge/web"]);
    const readme = fs.readFileSync(path.join(stage, "README.md"), "utf8");
    for (const match of readme.matchAll(/(?:src(?:set)?="|\]\()([^"\)]+)(?:"|\))/g)) {
      expect(fs.existsSync(path.join(stage, match[1]!)), match[1]).toBe(true);
    }
    expect(manifest).not.toHaveProperty("private");
    expect(manifest.dependencies.yaml).toBe("2.9.0");
    expect(manifest.dependencies.react).toBe("19.2.0");
    const core = path.join(stage, "node_modules/@codebridge/core");
    expect(fs.readdirSync(path.join(core, "dist")).sort()).toEqual(["index.d.ts", "index.js"]);
    const bridge = JSON.parse(fs.readFileSync(path.join(stage, "node_modules/@codebridge/bridge/package.json"), "utf8"));
    expect(bridge.dependencies["@codebridge/core"]).toBe("0.1.0");
    expect(bridge).not.toHaveProperty("scripts");
    expect(bridge).not.toHaveProperty("devDependencies");
    expect(fs.existsSync(path.join(core, "config.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(stage, ".env"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(stage, "node_modules/@codebridge/web/package.json"), "utf8")).dependencies).toEqual({});
  });
  it("blocks version drift instead of shipping mismatched CLI and health versions", () => {
    const root = fixture();
    const file = path.join(root, "packages/core/package.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.version = "0.0.9";
    fs.writeFileSync(file, JSON.stringify(doc));
    expect(() => checkVersions(root)).toThrow("Version mismatch");
  });
  it("rejects conflicting installed versions instead of arbitrarily selecting a runtime dependency", () => {
    const root = fixture();
    const bridgeFile = path.join(root, "apps/bridge/package.json");
    const bridge = JSON.parse(fs.readFileSync(bridgeFile, "utf8"));
    bridge.dependencies.yaml = "^2.6.1";
    fs.writeFileSync(bridgeFile, JSON.stringify(bridge));
    fs.writeFileSync(path.join(root, "apps/bridge/node_modules/yaml/package.json"), JSON.stringify({ name: "yaml", version: "2.8.0" }));
    expect(() => stageRelease(root, path.join(root, "output"))).toThrow("Conflicting installed versions of yaml");
  });
  it("rejects missing build output", () => {
    const root = fixture();
    fs.rmSync(path.join(root, "packages/core/dist"), { recursive: true });
    expect(() => stageRelease(root, path.join(root, "output"))).toThrow("Missing build");
  });
});
