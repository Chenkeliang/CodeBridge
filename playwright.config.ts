import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:5173" },
  webServer: {
    command: "pnpm --filter @codebridge/web dev -- --port 5173 --strictPort",
    url: "http://localhost:5173/workbench/",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});