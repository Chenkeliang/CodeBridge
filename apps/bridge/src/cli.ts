#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import {
  ConfigStore,
  DEFAULT_DATA_DIR,
  VERSION,
  defaultConfig,
} from "@codebridge/core";
import { FeishuBridge, runDoctor } from "@codebridge/channel-feishu";
import { TelegramBridge } from "@codebridge/channel-telegram";
import { createMemoryPlugin } from "@codebridge/memory-plugin";
import { SqliteEventStore } from "@codebridge/work-items";
import { ApprovalService } from "@codebridge/policy";
import { RunnerClient } from "@codebridge/runner-client";
import { RunExecutor } from "@codebridge/run-executor";
import { ProjectCatalogStore, ProjectDiscovery } from "@codebridge/project-catalog";
import { createProjectCatalogApp } from "./project-api.js";
import { createWebWorkbenchApp } from "./web-workbench.js";
import { hasFeishuCredentials, hasTelegramCredentials } from "./channel-config.js";

const program = new Command();

program
  .name("codebridge")
  .description("CodeBridge — 从飞书或 Telegram 远程驱动本机写代码")
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

    if (!hasFeishuCredentials(config) && !hasTelegramCredentials(config)) {
      console.error(
        "请至少配置一个通道：飞书 App 凭据或 TELEGRAM_BOT_TOKEN（配置文件：",
        store.path,
        ")",
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

    const bridge = hasFeishuCredentials(config)
      ? new FeishuBridge({
          config,
          dataDir,
          onLog: (m) => console.log(m),
        })
      : undefined;
    const telegram = config.telegram
      ? new TelegramBridge({
          config,
          dataDir,
          onLog: (m) => console.log(m),
        })
      : undefined;
    const workItemStore = new SqliteEventStore(
      path.join(dataDir, "orchestration.sqlite"),
    );
    const approvalService = new ApprovalService(
      workItemStore,
      path.join(dataDir, "approvals.sqlite"),
    );
    const runnerClient = new RunnerClient({
      baseUrl: config.runner.url,
      token: config.runner.token,
    });
    const runExecutor = new RunExecutor(workItemStore, runnerClient, {
      resolveRequest: (workItem, run) => {
        const latestMessage = workItemStore
          .listEvents(workItem.id)
          .reverse()
          .find((event) => event.type === "MESSAGE_RECEIVED")?.payload.message;
        const scope = workItem.workspaceScope[0];
        const cwd =
          (scope && config.workspaces?.named?.[scope]) ??
          (scope && path.isAbsolute(scope)
            ? scope
            : scope && config.workspaces?.root
              ? path.join(config.workspaces.root, scope)
              : undefined) ??
          config.workspaces?.default ??
          config.workspaces?.root ??
          process.cwd();
        const backendId =
          workItem.agentId && config.backends[workItem.agentId]
            ? workItem.agentId
            : config.defaultBackend;
        return {
          runId: run.id,
          sessionKey: {
            chatId: workItem.conversationId,
            backendId,
            cwd,
          },
          prompt:
            typeof latestMessage === "string" ? latestMessage : workItem.title,
        };
      },
    });
    const projectCatalog = new ProjectCatalogStore(
      path.join(dataDir, "project-catalog.sqlite"),
    );
    const projectDiscovery = new ProjectDiscovery(projectCatalog, {
      events: workItemStore,
    });
    const projectCatalogApp = createProjectCatalogApp(
      projectCatalog,
      projectDiscovery,
      config.runner.token,
    );
    const webWorkbenchApp = createWebWorkbenchApp({
      store: workItemStore,
      token: config.runner.token,
      agents: Object.keys(config.backends),
      workflows: [
        { id: "price-change", name: "价格调整检查与执行" },
      ],
    });

    store.onChange((c) => {
      bridge?.updateConfig(c);
      telegram?.updateConfig(c);
    });

    const shutdown = async () => {
      await bridge?.disconnect();
      await telegram?.disconnect();
      approvalService.close();
      projectDiscovery.close();
      workItemStore.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await bridge?.connect();
    if (telegram) await telegram.connect();

    const apiPort = config.bridge?.apiPort ?? 19790;
    const { serve } = await import("@hono/node-server");
    const { createBridgeApp } = await import("./outbound-api.js");
    serve({
      fetch: createBridgeApp(
        {
          sendOutboundFile: (chatId, rawPath, topicId) =>
            chatId.startsWith("telegram:")
              ? telegram
                ? telegram.sendOutboundFile(chatId, rawPath, topicId)
                : Promise.reject(new Error("Telegram 通道未配置"))
              : bridge
                ? bridge.sendOutboundFile(chatId, rawPath, topicId)
                : Promise.reject(new Error("飞书通道未配置")),
          sendOutboundMarkdown: (chatId, markdown, topicId) =>
            chatId.startsWith("telegram:")
              ? telegram
                ? telegram.sendOutboundMarkdown(chatId, markdown, topicId)
                : Promise.reject(new Error("Telegram 通道未配置"))
              : bridge
                ? bridge.sendOutboundMarkdown(chatId, markdown, topicId)
                : Promise.reject(new Error("飞书通道未配置")),
          sendOutboundMention: (chatId, ref, text, topicId) =>
            chatId.startsWith("telegram:")
              ? telegram
                ? telegram.sendOutboundMention(chatId, ref, text, topicId)
                : Promise.reject(new Error("Telegram 通道未配置"))
              : bridge
                ? bridge.sendOutboundMention(chatId, ref, text, topicId)
                : Promise.reject(new Error("飞书通道未配置")),
        },
        config.runner.token,
        workItemStore,
        approvalService,
        runExecutor,
        projectCatalogApp,
        webWorkbenchApp,
      ).fetch,
      hostname: "127.0.0.1",
      port: apiPort,
    });
    console.log(`出站 API（fcb）监听 http://127.0.0.1:${apiPort}`);
    console.log("CodeBridge 已启动，等待消息…");
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
