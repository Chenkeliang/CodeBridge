import path from "node:path";
import { ConfigStore } from "@feishu-code-bridge/core";

async function main() {
  const args = process.argv.slice(2);
  const configFlag = args.indexOf("-c");
  const configFile =
    configFlag >= 0 ? args[configFlag + 1] : undefined;

  if (configFile) {
    process.env.DATA_DIR = path.dirname(path.resolve(configFile));
  }

  const store = new ConfigStore();
  const config = store.reload();

  const listen =
    config.runnerHost?.listen ??
    process.env.RUNNER_LISTEN ??
    "127.0.0.1:19789";
  const [hostname, portStr] = listen.split(":");
  const port = Number(portStr);

  const { serve } = await import("@hono/node-server");
  const { createRunnerApp, RunnerHost } = await import("./server.js");

  const runnerHost = new RunnerHost({
    token: config.runner.token,
    config,
    maxConcurrentRuns: config.runnerHost?.maxConcurrentRuns,
    dataDir: path.dirname(store.path),
  });

  const app = createRunnerApp(runnerHost, config.runner.token);
  console.log(`feishu-code-runner listening on http://${hostname}:${port}`);
  serve({ fetch: app.fetch, hostname, port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
