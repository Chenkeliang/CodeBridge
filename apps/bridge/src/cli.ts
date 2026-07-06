#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import {
  ConfigStore,
  DEFAULT_DATA_DIR,
  VERSION,
  defaultConfig,
} from "@feishu-code-bridge/core";
import { FeishuBridge, runDoctor } from "@feishu-code-bridge/channel-feishu";
import { createMemoryPlugin } from "@feishu-code-bridge/memory-plugin";

const program = new Command();

program
  .name("feishu-code-bridge")
  .description("飞书码桥 — 用飞书远程驱动本机写代码")
  .version(VERSION);

program
  .command("start")
  .description("启动飞书桥接服务")
  .option("-c, --config <path>", "配置文件路径")
  .option("--data-dir <path>", "数据目录", DEFAULT_DATA_DIR)
  .action(async (opts: { config?: string; dataDir: string }) => {
    const dataDir = opts.dataDir;
    if (opts.config) {
      process.env.DATA_DIR = path.dirname(path.resolve(opts.config));
    } else {
      process.env.DATA_DIR = dataDir;
    }

    const store = new ConfigStore({ dataDir });
    const config = store.get();

    if (
      config.feishu.appId === "cli_placeholder" ||
      config.feishu.appSecret === "secret_placeholder"
    ) {
      console.error(
        "请配置飞书 App 凭据：编辑",
        store.path,
        "或设置 FEISHU_APP_ID / FEISHU_APP_SECRET",
      );
      process.exit(1);
    }

    const memory = createMemoryPlugin({
      enabled: config.plugins?.memory?.enabled ?? false,
      workspaceDir: config.workspaces?.default ?? process.cwd(),
    });
    if (memory.isEnabled()) {
      console.log("memory-plugin: enabled");
    }

    const bridge = new FeishuBridge({
      config,
      dataDir,
      onLog: (m) => console.log(m),
    });

    store.onChange((c) => bridge.updateConfig(c));

    const shutdown = async () => {
      await bridge.disconnect();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await bridge.connect();

    const apiPort = config.bridge?.apiPort ?? 19790;
    const { serve } = await import("@hono/node-server");
    const { createOutboundApp } = await import("./outbound-api.js");
    serve({
      fetch: createOutboundApp(bridge, config.runner.token).fetch,
      hostname: "127.0.0.1",
      port: apiPort,
    });
    console.log(`出站 API（fcb）监听 http://127.0.0.1:${apiPort}`);
    console.log("飞书码桥已启动，等待消息…");
  });

program
  .command("init")
  .description("生成默认 config.yaml")
  .option("--data-dir <path>", "数据目录", DEFAULT_DATA_DIR)
  .action((opts: { dataDir: string }) => {
    const store = new ConfigStore({ dataDir: opts.dataDir });
    store.save(defaultConfig());
    console.log("已写入:", store.path);
  });

program
  .command("doctor")
  .description("诊断配置与 Runner 连接")
  .option("--data-dir <path>", "数据目录", DEFAULT_DATA_DIR)
  .action(async (opts: { dataDir: string }) => {
    const store = new ConfigStore({ dataDir: opts.dataDir });
    const config = store.get();
    const report = await runDoctor(config, opts.dataDir);
    console.log(JSON.stringify(report, null, 2));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
