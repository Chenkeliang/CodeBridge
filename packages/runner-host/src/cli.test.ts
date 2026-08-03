import fs from "node:fs";
import { expect, it } from "vitest";

it("keeps the packaged Runner CLI directly executable", () => {
  const source = fs.readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

  expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
});
