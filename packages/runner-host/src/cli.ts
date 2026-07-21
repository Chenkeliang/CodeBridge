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

  // 适配器子进程是 detached（自成进程组），不会随 runner 死——退出前必须同步清场
  //（池内空闲进程 + 在飞 run），否则每次 stop/重启都会留孤儿。start.sh 的
  // SIGTERM→0.5s→SIGKILL 窗口内同步 kill 来得及。
  const shutdown = () => {
    try {
      runnerHost.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
