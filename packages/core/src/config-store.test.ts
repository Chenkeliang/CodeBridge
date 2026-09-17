import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "./config-store.js";

const isWindows = process.platform === "win32";

describe("ConfigStore#persist", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-config-store-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it.skipIf(isWindows)(
    "writes config.yaml with 0600 and creates a new parent dir with 0700",
    () => {
      const nestedDir = path.join(dataDir, "nested");
      const store = new ConfigStore({ dataDir: nestedDir });
      store.save({});

      const filePath = store.path;
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(nestedDir).mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(isWindows)(
    "chmods an already-existing config.yaml to 0600 on persist",
    () => {
      const store = new ConfigStore({ dataDir });
      store.save({});
      fs.chmodSync(store.path, 0o644);
      expect(fs.statSync(store.path).mode & 0o777).toBe(0o644);

      store.save({});

      expect(fs.statSync(store.path).mode & 0o777).toBe(0o600);
    },
  );
});
