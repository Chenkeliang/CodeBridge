#!/usr/bin/env node
import { AgentRegistry, projectSetupState, supportedAgentSetupManifests } from "@codebridge/agent-registry";
import { FeishuBridge, runDoctor } from "@codebridge/channel-feishu";
import { TelegramBridge } from "@codebridge/channel-telegram";
import {
  ConfigStore,
  DEFAULT_DATA_DIR,
  VERSION,
  defaultConfig,
  resolveDefaultAgentId,
} from "@codebridge/core";
import { McpRuntime, McpServerRegistry, SdkMcpClientFactory } from "@codebridge/mcp-runtime";
import { FeishuAlertMonitor } from "./feishu-alert-monitor.js";
import {
  ApprovalService,
  CapabilityRegistry,
  CapabilityRuntime,
  PolicyEngine,
  registerDemoCapabilities,
  registerEquityCapabilities,
} from "@codebridge/policy";
import { ProjectCatalogGitRepository, ProjectCatalogStore, ProjectDiscovery } from "@codebridge/project-catalog";
import { RunExecutor } from "@codebridge/run-executor";
import { RunnerClient } from "@codebridge/runner-client";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SessionCoordinator, SessionLeaseService, SessionRecoveryService, reclaimQueuedRuns } from "@codebridge/session-coordinator";
import { SqliteEventStore } from "@codebridge/work-items";
import { Command } from "commander";
import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChannelIngressApi, createChannelSessionIngress } from "./channel-ingress.js";
import { createMcpApp } from "./mcp-api.js";
import {
  DEFAULT_ROUTES,
  OUTBOUND_ROUTES,
  OutboundPublisherStore,
  addPublisher,
  listPublishers,
  publishersPath,
  revokePublisher,
  type OutboundRoute,
} from "./outbound-publishers.js";
import { createProjectCatalogApp } from "./project-api.js";
import { createSessionApp } from "./session-api.js";
import { SessionRuntimeMigration } from "./session-runtime-migration.js";
import { createSkillApp } from "./skill-api.js";
import { resolveStartupSurfaces } from "./startup-surfaces.js";
import { createWebFrontendApp } from "./web-frontend.js";

import { DeploymentService, mountDeploymentRoutes } from "./deployment.js";
import { startEventLoopLagMonitor } from "./event-loop-lag.js";

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
  .option("--web", "本次启动启用 Web，不修改配置文件")
  .action(async (opts: { config?: string; dataDir: string; web?: boolean }) => {
    const dataDir = opts.dataDir;
    if (opts.config) {
      process.env.DATA_DIR = path.dirname(path.resolve(opts.config));
    } else {
      process.env.DATA_DIR = dataDir;
    }

    const store = new ConfigStore({ dataDir });
    const config = store.get();
    const surfaces = resolveStartupSurfaces(config, { web: opts.web });

    const deployment: DeploymentService = new DeploymentService({
      configPath: path.join(dataDir, "deployer", "config.json"),
      feishuConnected: () => bridge?.isConnected ?? false,
      activeRuns: () => workItemStore.listRunsByStatus(["running"]).length,
    });
    let alertMonitor: FeishuAlertMonitor | undefined;
    const bridge: FeishuBridge | undefined = surfaces.feishu
      ? new FeishuBridge({
          config,
          dataDir,
          onDeploymentMessage: (message) => deployment.handleFeishuMessage(message),
          prepareAlertReply: (message, topicId) => alertMonitor?.prepareReply(message, topicId),
          onAlertReaction: async (reaction) => { await alertMonitor?.prepareReaction(reaction); },
          isAlertMessage: (chatId, messageId) => alertMonitor?.isAlertMessage(chatId, messageId) ?? false,
          isAlertChat: (chatId) => store.get().feishu.alertMonitor?.groups.some((group) => group.chatId === chatId) ?? false,
          isAlertSender: (chatId, ids) => store.get().feishu.alertMonitor?.groups.some((group) => group.chatId === chatId && ids.some((id) => group.senderAppIds.includes(id))) ?? false,
          isMaintenance: () => deployment.isMaintenance(),
          onLog: (m) => console.log(m),
        })
      : undefined;
    const telegram = surfaces.telegram && config.telegram
      ? new TelegramBridge({
          config,
          dataDir,
          onLog: (m) => console.log(m),
        })
      : undefined;
    const orchestrationPath = path.join(dataDir, "orchestration.sqlite");
    const workItemStore = new SqliteEventStore(orchestrationPath);
    const sessionCatalog = new SessionCatalogStore(
      path.join(dataDir, "sessions.sqlite"),
      {
        defaultCwd:
          config.workspaces?.default ?? config.workspaces?.root ?? process.cwd(),
      },
    );
    const migration = new SessionRuntimeMigration(sessionCatalog, workItemStore);
    try {
      const migrationResult = migration.run({ batchSize: 1_000 });
      console.log("session runtime migration complete", migrationResult);
    } catch (error) {
      if (
        error instanceof Error
        && error.message === "session_runtime_migration_conflict"
      ) {
        console.error(
          "session runtime migration conflict",
          JSON.stringify({
            conflicts: (error as Error & {
              conflicts?: unknown;
            }).conflicts ?? [],
          }, null, 2),
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    const approvalService = new ApprovalService(
      workItemStore,
      path.join(dataDir, "approvals.sqlite"),
    );
    const capabilityRegistry = new CapabilityRegistry([], {
      databasePath: path.join(dataDir, "capabilities.sqlite"),
    });
    const capabilityRuntime = new CapabilityRuntime();
    registerDemoCapabilities(capabilityRegistry, capabilityRuntime);
    registerEquityCapabilities(capabilityRegistry, capabilityRuntime);
    const policyEngine = new PolicyEngine(capabilityRegistry);
    const mcpRegistry = new McpServerRegistry(path.join(dataDir, "mcp.sqlite"));
    for (const [id, definition] of Object.entries(config.orchestration?.mcpServers ?? {})) {
      mcpRegistry.registerServer({ id, ...definition });
    }
    const mcpRuntime = new McpRuntime(
      mcpRegistry,
      new SdkMcpClientFactory(),
      capabilityRegistry,
      capabilityRuntime,
    );
    const mcpApp = createMcpApp(mcpRegistry, mcpRuntime, config.runner.token);
    for (const server of mcpRegistry.listServers().filter((candidate) => candidate.enabled !== false)) {
      void mcpRuntime.discover(server.id).catch((error) => {
        console.warn(`MCP discovery failed (${server.id}):`, error instanceof Error ? error.message : String(error));
      });
    }
    const runnerClient = new RunnerClient({
      baseUrl: config.runner.url,
      token: config.runner.token,
    });
    const skillApp = createSkillApp(runnerClient, config.runner.token);
    const sessionCoordinator = new SessionCoordinator(workItemStore, {
      maxQueuedTurns:
        config.orchestration?.session?.maxQueuedTurns ?? 100,
    });
    const sessionLeaseService = new SessionLeaseService(workItemStore);
    // hostname:pid 保证重启后的进程永远不会匹配到上一个进程留下的 lease_owner，
    // 这样 startup 阶段的 scanExpired（此时 runExecutor 还没执行任何 Run）
    // 仍然会把上个进程遗留的 stale Run 正常中断，而不会被误判为「自己还在执行」。
    const executorOwner = `${hostname()}:${process.pid}`;
    // runExecutor 在下面才构造，这里先用闭包延迟引用，供恢复扫描判断
    // 「这个过期租约是不是我自己仍在执行的 Run」。
    let runExecutor: RunExecutor;
    const sessionRecovery = new SessionRecoveryService(
      workItemStore,
      sessionCoordinator,
      sessionLeaseService,
      () => new Date(),
      {
        owner: executorOwner,
        isExecuting: (runId) => runExecutor.isExecuting(runId),
      },
    );
    runExecutor = new RunExecutor(workItemStore, runnerClient, {
      shouldPauseDispatch: () => deployment.isMaintenance(),
      approvals: approvalService,
      policy: policyEngine,
      capabilities: capabilityRuntime,
      sessionCoordinator,
      sessionLeaseService,
      executorOwner,
      onEvent: (run, event) => {
        if (event.type === "session") {
          const workItem = workItemStore.getWorkItem(run.workItemId);
          if (workItem?.conversationId.startsWith("conv_")) {
            const session = sessionCatalog.getSession(
              `sess_${workItem.conversationId.slice("conv_".length)}`,
            );
            if (session) {
              sessionCatalog.updateSession(session.id, {
                providerSessionId: event.sessionId,
                status: "active",
              });
            }
          }
        }
      },
      resolveRequest: (workItem, run) => {
        const linkedSession = workItem.conversationId.startsWith("conv_")
          ? sessionCatalog.getSession(`sess_${workItem.conversationId.slice("conv_".length)}`)
          : undefined;
        const latestMessage = workItemStore
          .listEvents(workItem.id)
          .reverse()
          .find((event) => event.type === "MESSAGE_RECEIVED")?.payload.message;
        const scope = linkedSession?.cwd ?? workItem.workspaceScope[0];
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
        const requestedBackend = linkedSession?.agentId ?? workItem.agentId;
          const backendId =
          requestedBackend && config.backends[requestedBackend]
            ? requestedBackend
            : resolveDefaultAgentId(config);
        const basePrompt =
          typeof latestMessage === "string" ? latestMessage : workItem.title;
        const deploymentGuidance = deployment.guidanceForRun(run.id, workItemStore);
        const guidedPrompt = deploymentGuidance ? `${basePrompt}\n\n${deploymentGuidance}` : basePrompt;
        const prompt = guidedPrompt;
        return {
          runId: run.id,
          sessionKey: {
            chatId: workItem.conversationId,
            backendId,
            cwd,
          },
          prompt,
          model: linkedSession?.model ?? undefined,
          effort: linkedSession?.effort ?? undefined,
          acpConfig: linkedSession?.configOverrides,
          mode: linkedSession?.permissionMode ?? undefined,
          resumeSessionId: run.providerSessionId ?? undefined,
          additionalDirectories: linkedSession?.additionalDirectories,
        };
      },
    });
    const eventLoopLagMonitor = startEventLoopLagMonitor();
    sessionRecovery.scanExpired();
    sessionRecovery.scanCancellationDeadlines();
    const reclaimQueued = (): void => {
      if (deployment.isMaintenance()) return;
      try {
        reclaimQueuedRuns({
          store: workItemStore,
          coordinator: sessionCoordinator,
          execute: (runId) => {
            void runExecutor.execute(runId).catch(() => {});
          },
        });
      } catch (error) {
        console.error(
          "Queued run reclaim failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    const recoveryInterval = setInterval(() => {
      try {
        sessionRecovery.scanExpired();
      } catch (error) {
        console.error(
          "Session recovery scan failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
      reclaimQueued();
    }, 15_000);
    const cancellationInterval = setInterval(() => {
      try {
        sessionRecovery.scanCancellationDeadlines();
      } catch (error) {
        console.error(
          "Session cancellation scan failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }, 1_000);
    reclaimQueued();
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
      config.orchestration?.projectCatalog
        ? new ProjectCatalogGitRepository({
            repositoryPath: config.orchestration.projectCatalog.repositoryPath,
            baseRef: config.orchestration.projectCatalog.baseRef,
            catalogPath: config.orchestration.projectCatalog.catalogPath,
          })
        : undefined,
    );
    const supportedSetupManifests = new Map(
      supportedAgentSetupManifests.map((manifest) => [manifest.agentId, manifest] as const),
    );
    const knownAgents = [...supportedSetupManifests.keys(), ...Object.keys(config.backends)];
    const agentIds = [...new Set(knownAgents)];
    const registry = new AgentRegistry({ databasePath: path.join(dataDir, "agents.sqlite") });
    agentIds.forEach((agentId) => {
      const profile = config.backends[agentId];
      const manifest = supportedSetupManifests.get(agentId);
      if (manifest) {
        registry.register({
          agentId,
          displayName: manifest.displayName,
          adapter: manifest.adapter,
          status: "needs_setup",
          capabilities: profile ? ["session", "workspace", "run"] : [],
          models: profile?.model ? [profile.model] : [],
          sessionFeatures: profile
            ? ["resume", "close", "delete", ...(profile.type === "pi-sdk" ? ["fork"] : [])]
            : [],
          setup: projectSetupState({
            installation: "unknown",
            configuration: "unknown",
            runtime: "not_started",
          }),
          setupManifest: manifest,
        });
        return;
      }
      registry.register({
        agentId,
        displayName: agentId,
        adapter: agentId === "pi" ? "sdk" : profile?.type === "generic-spawn" ? "cli" : "acp",
        status: profile ? "healthy" : "needs_setup",
        capabilities: profile ? ["session", "workspace", "run"] : [],
        models: profile?.model ? [profile.model] : [],
        sessionFeatures: profile
          ? ["resume", "close", "delete", ...(profile.type === "pi-sdk" ? ["fork"] : [])]
          : [],
      });
    });
    // Runner may still be booting when the Bridge starts (launchd starts both
    // concurrently), so retry in the background instead of a one-shot attempt
    // that leaves every Agent stuck in needs_setup until restart.
    const applyAgentSetup = async (): Promise<boolean> => {
      const setup = await runnerClient.listAgentSetup();
      for (const agent of setup.agents) {
        registry.updateSetup(agent.agentId, {
          installation: agent.installation,
          configuration: agent.configuration,
          runtime: agent.runtime,
          version: agent.version,
          executablePath: agent.executablePath,
          diagnostic: agent.diagnostic,
        });
      }
      return true;
    };
    void (async () => {
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          await applyAgentSetup();
          if (attempt > 0) console.log(`Agent setup detection succeeded after ${attempt + 1} attempts`);
          return;
        } catch (error) {
          if (attempt === 149) {
            console.warn("Agent setup detection failed:", error instanceof Error ? error.message : String(error));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, attempt < 30 ? 1_000 : 15_000));
        }
      }
    })();
    const agentHealthAdapters = agentIds
      .filter((agentId) => Boolean(config.backends[agentId]))
      .map((agentId) => ({
        agentId,
        kind: registry.get(agentId)!.adapter,
        health: async () => (await runnerClient.health()).ok ? "healthy" as const : "unavailable" as const,
      }));
    await Promise.all(agentHealthAdapters.map((adapter) => registry.refresh(adapter)));
    const stopAgentHealthChecks = registry.startHealthChecks(agentHealthAdapters, 5_000);
    const webFrontendApp = surfaces.web
      ? createWebFrontendApp({
          staticDirectory:
            config.web.staticDirectory ??
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist"),
          token: config.runner.token,
        })
      : undefined;
    const sessionCatalogApp = createSessionApp(
      {
        catalog: sessionCatalog,
        agents: () => registry.list(),
        agentRegistry: registry,
        configStore: store,
        workItems: workItemStore,
        executor: runExecutor,
        runner: runnerClient,
        discovery: projectDiscovery,
        capabilities: capabilityRegistry,
        approvals: approvalService,
        coordinator: sessionCoordinator,
        defaultCwd: config.workspaces?.default ?? config.workspaces?.root ?? process.cwd(),
      },
      config.runner.token,
    );
    const channelSessionIngress = createChannelSessionIngress(
      createChannelIngressApi(sessionCatalogApp),
      config.runner.token,
    );
    bridge?.setSessionIngress(channelSessionIngress);
    telegram?.setSessionIngress(channelSessionIngress);
    if (bridge) alertMonitor = new FeishuAlertMonitor({
      statePath: path.join(dataDir, "feishu-alert-monitor.json"),
      config: () => store.get().feishu.alertMonitor,
      transport: bridge,
      isMaintenance: () => deployment.isMaintenance(),
      log: (message) => console.log(message),
    });

    store.onChange((c) => {
      bridge?.updateConfig(c);
      telegram?.updateConfig(c);
    });

    const shutdown = async () => {
      await alertMonitor?.stop();
      await bridge?.disconnect();
      await telegram?.disconnect();
      approvalService.close();
      await mcpRuntime.close();
      mcpRegistry.close();
      capabilityRegistry.close();
      clearInterval(recoveryInterval);
      clearInterval(cancellationInterval);
      eventLoopLagMonitor.stop();
      stopAgentHealthChecks();
      registry.close();
      projectDiscovery.close();
      sessionCatalog.close();
      workItemStore.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await bridge?.connect();
    alertMonitor?.start();
    if (telegram) await telegram.connect();

    const apiPort = config.bridge?.apiPort ?? 19790;
    const { serve } = await import("@hono/node-server");
    const { createBridgeApp } = await import("./outbound-api.js");
    // 凭据文件坏掉只该让定时任务发不出去，不该连带拖垮整个 Bridge。
    const publisherStore = new OutboundPublisherStore(dataDir, config.runner.token, (error) => {
      console.error(`出站发布者配置无效，沿用上一份可用凭据：${error.message}`);
    });
    const apiApp = createBridgeApp(
        {
          setOutboundAlertStatus: (chatId, topicId, status, summary) => alertMonitor
            ? alertMonitor.setStatus(chatId, topicId, status, summary)
            : Promise.reject(new Error("告警监控未配置")),
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
webFrontendApp,
sessionCatalogApp,
mcpApp,
skillApp,
() => publisherStore.current()
);
    mountDeploymentRoutes(apiApp, deployment, workItemStore);
    serve({
      fetch: apiApp.fetch,
      hostname: "127.0.0.1",
      port: apiPort,
    });
    console.log(`Core API 监听 http://127.0.0.1:${apiPort}`);
    console.log(`Web: ${surfaces.web ? `enabled at http://127.0.0.1:${apiPort}/workbench/` : "disabled"}`);
    console.log(`Feishu: ${surfaces.feishu ? "enabled" : "disabled"}`);
    const loadedPublishers = publisherStore.current();
    console.log(`出站发布者: ${loadedPublishers.length
      ? loadedPublishers.map((row) => `${row.label}[${row.routes.join("/")}]`).join(", ")
      : "none"}`);
    console.log(`Telegram: ${surfaces.telegram ? "enabled" : "disabled"}`);
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

const publisher = program
  .command("publisher")
  .description("管理定时任务等非 Agent 发送方的出站凭据");

function runnerTokenOf(dataDir: string): string {
  const store = new ConfigStore({ dataDir });
  // 没有 config.yaml 时 ConfigStore 会回落到占位 token，静默把凭据写进错的目录。
  if (!fs.existsSync(store.path)) {
    throw new Error(`${store.path} 不存在：--data-dir 指错了，或该目录尚未 codebridge init`);
  }
  return store.get().runner.token;
}

function parseRouteOption(value: string): OutboundRoute[] {
  const routes = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (routes.length === 0) {
    throw new Error(`--routes 不能为空，省略它即表示只授予 ${DEFAULT_ROUTES.join("、")}`);
  }
  for (const route of routes) {
    if (!OUTBOUND_ROUTES.includes(route as OutboundRoute)) {
      throw new Error(`未知路由 ${route}，可选：${OUTBOUND_ROUTES.join("、")}`);
    }
  }
  return routes as OutboundRoute[];
}

publisher
  .command("add")
  .description("签发一条凭据；同名 label 视为轮换，旧 token 立即作废")
  .requiredOption("--label <name>", "调用方名字，例如 stock-daily-trade")
  .requiredOption("--chat <id>", "固定收件人：飞书 oc_ 开头，Telegram telegram: 开头")
  .option("--topic <id>", "话题 ID")
  .option("--routes <list>", `逗号分隔，默认 markdown,mention；可选 ${OUTBOUND_ROUTES.join("、")}`)
  .option("--data-dir <path>", "数据目录", DEFAULT_DATA_DIR)
  .action((opts: { label: string; chat: string; topic?: string; routes?: string; dataDir: string }) => {
    const issued = addPublisher(opts.dataDir, runnerTokenOf(opts.dataDir), {
      label: opts.label,
      chatId: opts.chat,
      topicId: opts.topic,
      routes: opts.routes === undefined ? undefined : parseRouteOption(opts.routes),
    });
    console.log(JSON.stringify({
      label: issued.label, token: issued.token, chatId: issued.chatId,
      topicId: issued.topicId, routes: issued.routes, path: publishersPath(opts.dataDir),
    }, null, 2));
    console.error("token 只在此刻打印一次，请立刻写入调用方配置；Bridge 会自动热加载，无需重启。");
  });

publisher
  .command("list")
  .description("列出已登记的发布者（不含 token）")
  .option("--data-dir <path>", "数据目录", DEFAULT_DATA_DIR)
  .action((opts: { dataDir: string }) => {
    console.log(JSON.stringify(listPublishers(opts.dataDir, runnerTokenOf(opts.dataDir)), null, 2));
  });

publisher
  .command("revoke")
  .description("吊销一条凭据")
  .requiredOption("--label <name>", "要吊销的 label")
  .option("--data-dir <path>", "数据目录", DEFAULT_DATA_DIR)
  .action((opts: { label: string; dataDir: string }) => {
    const removed = revokePublisher(opts.dataDir, runnerTokenOf(opts.dataDir), opts.label);
    console.log(JSON.stringify({ label: opts.label, revoked: removed }, null, 2));
    if (!removed) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
