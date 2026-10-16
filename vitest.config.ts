import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    include: ["packages/**/*.test.ts", "apps/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
  },
});
