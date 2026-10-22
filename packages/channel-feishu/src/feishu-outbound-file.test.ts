import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveOutboundFile } from "./feishu-outbound-file.js";

let home: string;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-home-"));
  await fs.mkdir(path.join(home, "Desktop"));
  await fs.writeFile(path.join(home, "Desktop", "report.csv"), "a,b\n1,2\n");
});

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("resolveOutboundFile", () => {
  it("resolves an absolute path inside home", async () => {
    const file = await resolveOutboundFile(
      path.join(home, "Desktop", "report.csv"),
      home,
    );
    expect(file.fileName).toBe("report.csv");
  });

  it("expands ~/ against the given home", async () => {
    const file = await resolveOutboundFile("~/Desktop/report.csv", home);
    expect(file.fileName).toBe("report.csv");
  });

  it("rejects relative paths", async () => {
    await expect(resolveOutboundFile("Desktop/report.csv", home)).rejects.toThrow(
      "绝对路径",
    );
  });

  it("rejects paths outside home", async () => {
    await expect(resolveOutboundFile("/etc/hosts", home)).rejects.toThrow(
      "主目录内",
    );
  });

  it("rejects home escape via ..", async () => {
    await expect(
      resolveOutboundFile(path.join(home, "Desktop", "..", "..", "escape.txt"), home),
    ).rejects.toThrow(/不存在|主目录内/);
  });

  it("rejects missing files", async () => {
    await expect(
      resolveOutboundFile(path.join(home, "nope.csv"), home),
    ).rejects.toThrow("不存在");
  });

  it("rejects directories", async () => {
    await expect(
      resolveOutboundFile(path.join(home, "Desktop"), home),
    ).rejects.toThrow("不是普通文件");
  });
});
