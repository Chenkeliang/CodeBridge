import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWebFrontendApp } from "./web-frontend.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("React Web frontend hosting", () => {
  it("serves the built application and its assets under /workbench", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-web-"));
    directories.push(directory);
    fs.mkdirSync(path.join(directory, "assets"));
    fs.writeFileSync(path.join(directory, "index.html"), '<div id="root"></div><script src="./assets/app.js"></script>');
    fs.writeFileSync(path.join(directory, "assets", "app.js"), "window.__codebridge = true;");

    const app = createWebFrontendApp({ staticDirectory: directory, token: "web-token" });
    const index = await app.request("/");
    const asset = await app.request("/assets/app.js");
    const config = await app.request("/config.json");

    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<div id="root"></div>');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("window.__codebridge = true");
    expect(await config.json()).toEqual({ token: "web-token" });
  });

  it("returns 404 when the optional Web build is unavailable", async () => {
    const app = createWebFrontendApp({ staticDirectory: "/missing/codebridge-web" });
    expect((await app.request("/")).status).toBe(404);
  });

  it("accepts the mount prefix when the app is exercised outside Hono route composition", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-web-prefix-"));
    directories.push(directory);
    fs.mkdirSync(path.join(directory, "assets"));
    fs.writeFileSync(path.join(directory, "index.html"), "<div>shell</div>");
    fs.writeFileSync(path.join(directory, "assets", "app.js"), "asset");

    const app = createWebFrontendApp({ staticDirectory: directory });
    const response = await app.request("/workbench/assets/app.js");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset");
  });
});
