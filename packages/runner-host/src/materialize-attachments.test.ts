import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAttachments,
  materializeAttachments,
} from "./materialize-attachments.js";

describe("materializeAttachments", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
    vi.restoreAllMocks();
  });

  it("writes base64 attachments to disk", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-attach-"));
    dirs.push(dataDir);
    const payload = Buffer.from("png-bytes").toString("base64");
    const local = await materializeAttachments(dataDir, "run-1", [
      {
        name: "shot.png",
        mimeType: "image/png",
        dataBase64: payload,
      },
    ]);
    expect(local).toHaveLength(1);
    const bytes = await fs.readFile(local[0]!.path);
    expect(bytes.toString()).toBe("png-bytes");
  });

  it("keeps all file bytes and prevents duplicate or unsafe names escaping the run", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-attach-"));
    dirs.push(dataDir);
    const names = ["../a.txt", "C:\\files\\a.txt", "a-2.txt", "..", ".", "bad\u0000name.pdf", "movie.mp4", "report.docx", "sheet.xlsx", "audio.mp3", "archive.bin", "A.TXT"];
    const types = ["text/plain", "text/plain", "text/plain", "application/octet-stream", "application/octet-stream", "application/pdf", "video/mp4", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "audio/mpeg", "application/octet-stream", "text/plain"];
    const payloads = names.map((_, i) => Buffer.from([0, 255, i, 128, 10]));
    const local = await materializeAttachments(dataDir, "all-types", names.map((name, i) => ({
      name, mimeType: types[i]!, dataBase64: payloads[i]!.toString("base64"),
    })));
    expect(new Set(local.map((file) => file.name!.toLowerCase())).size).toBe(names.length);
    expect(local.slice(0, 3).map((file) => file.name)).toEqual(["a.txt", "a-2.txt", "a-2-2.txt"]);
    for (let i = 0; i < local.length; i++) {
      expect(path.dirname(local[i]!.path)).toBe(path.join(dataDir, "attachments", "all-types"));
      expect(local[i]!.name).not.toMatch(/[\\\x00-\x1f\x7f]/);
      expect(local[i]!.mimeType).toBe(types[i]);
      expect(await fs.readFile(local[i]!.path)).toEqual(payloads[i]);
    }
    await materializeAttachments(dataDir, "other-run", [{ name: "keep.txt", dataBase64: "eA==", mimeType: "text/plain" }]);
    await cleanupAttachments(dataDir, "all-types");
    await expect(fs.access(local[0]!.path)).rejects.toThrow();
    expect(await fs.readFile(path.join(dataDir, "attachments", "other-run", "keep.txt"), "utf8")).toBe("x");
  });

  it("bounds UTF-8 filenames including duplicate suffixes and preserves every payload", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-attach-"));
    dirs.push(dataDir);
    const boundary = `${"a".repeat(251)}.txt`;
    const chinese = `${"订单".repeat(100)}.xlsx`;
    const emoji = `${"📄".repeat(100)}.pdf`;
    const names = [boundary, boundary, chinese, chinese, emoji, `file.${"x".repeat(300)}`];
    const payloads = names.map((_, index) => Buffer.from([0, 255, index, 128]));
    const local = await materializeAttachments(dataDir, "long-names", names.map((name, index) => ({
      name, mimeType: "application/octet-stream", dataBase64: payloads[index]!.toString("base64"),
    })));
    expect(local[0]!.name).toBe(boundary);
    expect(local[1]!.name).toBe(`${"a".repeat(249)}-2.txt`);
    expect(local[2]!.name).toMatch(/\.xlsx$/);
    expect(local[3]!.name).toMatch(/-2\.xlsx$/);
    expect(local[4]!.name).toMatch(/^(📄)+\.pdf$/u);
    expect(new Set(local.map((file) => file.name)).size).toBe(names.length);
    for (let index = 0; index < local.length; index++) {
      expect(Buffer.byteLength(local[index]!.name!, "utf8")).toBeLessThanOrEqual(255);
      expect(local[index]!.name).not.toContain("\uFFFD");
      expect(await fs.readFile(local[index]!.path)).toEqual(payloads[index]);
    }
  });

  it("removes the run's attachment directory on cleanup", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-attach-"));
    dirs.push(dataDir);
    const payload = Buffer.from("png-bytes").toString("base64");
    const local = await materializeAttachments(dataDir, "run-2", [
      {
        name: "shot.png",
        mimeType: "image/png",
        dataBase64: payload,
      },
    ]);
    const runDir = path.dirname(local[0]!.path);

    await cleanupAttachments(dataDir, "run-2");

    await expect(fs.access(runDir)).rejects.toThrow();
  });

  it("cleans up partial files when a later write fails", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-attach-"));
    dirs.push(dataDir);
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile")
      .mockImplementationOnce(writeFile)
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(materializeAttachments(dataDir, "failed-run", [
      { name: "first.txt", mimeType: "text/plain", dataBase64: "eA==" },
      { name: "second.pdf", mimeType: "application/pdf", dataBase64: "eQ==" },
    ])).rejects.toThrow("disk full");
    await expect(fs.access(path.join(dataDir, "attachments", "failed-run"))).rejects.toThrow();
  });

  it("does not throw when cleaning up a nonexistent runId", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-attach-"));
    dirs.push(dataDir);

    await expect(cleanupAttachments(dataDir, "no-such-run")).resolves.toBeUndefined();
  });
});
