import { vi } from "vitest";

// Credential tests must inject SecretOptions.run instead of touching the developer's keychain.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const execFileSync = (file: string, args: readonly string[] = [], options?: unknown) => {
    if (file === "/usr/bin/security" || file === "security" || file === "secret-tool") {
      throw new Error("Tests must inject SecretOptions.run; operating-system keychain access is blocked");
    }
    return Reflect.apply(actual.execFileSync, actual, [file, args, options]);
  };
  return { ...actual, execFileSync };
});
