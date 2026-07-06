import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeFcbScript } from "./fcb-script.js";

const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("writeFcbScript", () => {
  it("writes an executable fcb into <dataDir>/bin", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-data-"));
    tmpDirs.push(dataDir);

    const binDir = await writeFcbScript(dataDir);
    expect(binDir).toBe(path.join(dataDir, "bin"));

    const file = path.join(binDir, "fcb");
    const content = await fs.readFile(file, "utf8");
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(content).toContain("FCB_CHAT_ID");

    const stat = await fs.stat(file);
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it("is idempotent", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-data-"));
    tmpDirs.push(dataDir);
    await writeFcbScript(dataDir);
    await expect(writeFcbScript(dataDir)).resolves.toBe(
      path.join(dataDir, "bin"),
    );
  });
});
