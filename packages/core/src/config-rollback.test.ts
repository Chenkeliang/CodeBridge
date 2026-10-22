import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigStore } from "./config-store.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach((p) => fs.rmSync(p, { recursive: true, force: true })); });
it("keeps disk and in-memory authorization unchanged when configuration persistence fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-config-rollback-")); roots.push(root);
  const store = new ConfigStore({ dataDir: root }); store.save({});
  const disk = fs.readFileSync(store.path, "utf8"), config = structuredClone(store.get()), changed = vi.fn(); store.onChange(changed);
  vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("fixture disk failure"); });
  expect(() => store.update((value) => { value.access = { admins: ["ou_fixture"] }; return value; })).toThrow("fixture disk failure");
  expect(store.get()).toEqual(config); expect(fs.readFileSync(store.path, "utf8")).toBe(disk); expect(changed).not.toHaveBeenCalled();
});
