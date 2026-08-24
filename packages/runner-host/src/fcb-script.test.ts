import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { writeFcbScript } from "./fcb-script.js";

const tmpDirs: string[] = [];
const executeFile = promisify(execFile);

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
    expect(content).toContain('cmd === "mention"');
    expect(content).toContain('post("/outbound/mention"');
    expect(content).toContain("FCB_RUN_ID");
    expect(content).toContain('rest[0] === "suggest"');
    expect(content).toContain('post("/v1/flows/recommendations"');
    expect(content).toContain('rest[0] === "batch"');
    expect(content).toContain('post("/v1/flow-invocation-drafts"');

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

  it("submits a bounded JSON batch draft using the trusted Run identity", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-data-"));
    tmpDirs.push(dataDir);
    const binDir = await writeFcbScript(dataDir);
    const draftPath = path.join(dataDir, "draft.json");
    await fs.writeFile(draftPath, JSON.stringify({
      source_run_id: "caller-supplied",
      flow_id: "flow_orders",
      definition_revision: "sha256:def",
      global_inputs: { region: "cn" },
      items: [{ item_id: "one", inputs: { oid: 1 }, evidence: {} }],
      source_refs: ["event:message-1"],
    }));
    let received: Record<string, unknown> | null = null;
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        expect(request.url).toBe("/v1/flow-invocation-drafts");
        expect(request.headers.authorization).toBe("Bearer token");
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ draft_id: "draft_1", status: "ready" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address missing");
    try {
      await executeFile(path.join(binDir, "fcb"), ["flow", "batch", draftPath], {
        env: {
          ...process.env,
          FCB_API: `http://127.0.0.1:${address.port}`,
          FCB_TOKEN: "token",
          FCB_CHAT_ID: "chat_1",
          FCB_RUN_ID: "run_trusted",
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) =>
        error ? reject(error) : resolve()
      ));
    }
    expect(received).toMatchObject({
      source_run_id: "run_trusted",
      flow_id: "flow_orders",
      definition_revision: "sha256:def",
      items: [{ item_id: "one", inputs: { oid: 1 } }],
    });
    expect(received).not.toHaveProperty("session_id");
  });
});
