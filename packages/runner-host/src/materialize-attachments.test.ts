import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeAttachments } from "./materialize-attachments.js";

describe("materializeAttachments", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
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
});
