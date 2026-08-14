#!/usr/bin/env node
import path from "node:path";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  ConfigStore,
  DEFAULT_DATA_DIR,
  VERSION,
  defaultConfig,
} from "@codebridge/core";
import { FeishuBridge, runDoctor } from "@codebridge/channel-feishu";
import { TelegramBridge } from "@codebridge/channel-telegram";
import { SqliteEventStore, type PersistedPlanStep } from "@codebridge/work-items";
import {
  ApprovalService,
  CapabilityRegistry,
  CapabilityRuntime,
  PolicyEngine,
} from "@codebridge/policy";
import { RunnerClient } from "@codebridge/runner-client";
import { RunExecutor } from "@codebridge/run-executor";
import {
  SessionCoordinator,
  SessionLeaseService,
  SessionRecoveryService,
} from "@codebridge/session-coordinator";
import {
  ProjectCatalogGitRepository,
  ProjectCatalogStore,
  ProjectDiscovery,
} from "@codebridge/project-catalog";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { AgentRegistry } from "@codebridge/agent-registry";
import { projectSetupState, supportedAgentSetupManifests } from "@codebridge/agent-registry";
import {
  McpRuntime,
  McpServerRegistry,
  SdkMcpClientFactory,
} from "@codebridge/mcp-runtime";
import { createProjectCatalogApp } from "./project-api.js";
import { createWebFrontendApp } from "./web-frontend.js";
import { createSessionApp } from "./session-api.js";
import { createFlowApp } from "./flow-api.js";
import { createChannelSessionIngress } from "./channel-ingress.js";
import { createMcpApp } from "./mcp-api.js";
import { resolveStartupSurfaces } from "./startup-surfaces.js";

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

    const bridge = surfaces.feishu
      ? new FeishuBridge({
          config,
          dataDir,
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
    const workItemStore = new SqliteEventStore(
      path.join(dataDir, "orchestration.sqlite"),
    );
    const sessionCatalog = new SessionCatalogStore(
      path.join(dataDir, "sessions.sqlite"),
    );
    const flowCatalog = new FlowCatalogStore(path.join(dataDir, "flows.sqlite"));
    const approvalService = new ApprovalService(
      workItemStore,
      path.join(dataDir, "approvals.sqlite"),
    );
    const capabilityRegistry = new CapabilityRegistry([], {
      databasePath: path.join(dataDir, "capabilities.sqlite"),
    });
    const capabilityRuntime = new CapabilityRuntime();
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
    const sessionCoordinator = new SessionCoordinator(workItemStore, {
      maxQueuedTurns:
        config.orchestration?.session?.maxQueuedTurns ?? 100,
    });
    const sessionLeaseService = new SessionLeaseService(workItemStore);
    const sessionRecovery = new SessionRecoveryService(
      workItemStore,
      sessionCoordinator,
      sessionLeaseService,
    );
    const executorOwner = `${hostname()}:${process.pid}`;
    const runExecutor = new RunExecutor(workItemStore, runnerClient, {
      approvals: approvalService,
      policy: policyEngine,
      capabilities: capabilityRuntime,
      sessionCoordinator,
      sessionLeaseService,
      executorOwner,
      onEvent: (run, event) => {
        if (event.type !== "session") return;
        const workItem = workItemStore.getWorkItem(run.workItemId);
        if (!workItem || !workItem.conversationId.startsWith("conv_")) return;
        const session = sessionCatalog.getSession(
          `sess_${workItem.conversationId.slice("conv_".length)}`,
        );
        if (session) {
          sessionCatalog.updateSession(session.id, {
            providerSessionId: event.sessionId,
            status: "active",
          });
        }
      },
      resolveRequest: (workItem, run, step?: PersistedPlanStep) => {
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
            : config.defaultBackend;
        const basePrompt =
          typeof latestMessage === "string" ? latestMessage : workItem.title;
        const prompt = step
          ? [
              `[Workflow ${workItem.workflowId ?? "临时计划"}${run.workflowRevision ? ` @ ${run.workflowRevision}` : ""}]`,
              `[执行步骤: ${step.id}]`,
              `[Capability: ${step.capabilityId ?? "manual"}]`,
              `[Risk: ${step.risk}]`,
              step.purpose ? `[Purpose: ${step.purpose}]` : "",
              basePrompt,
            ].filter(Boolean).join("\n")
          : workItem.workflowId
            ? `[参考 Workflow: ${workItem.workflowId}]\n${basePrompt}`
            : basePrompt;
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
          resumeSessionId: linkedSession?.providerSessionId ?? undefined,
          additionalDirectories: linkedSession?.additionalDirectories,
        };
      },
    });
    sessionRecovery.scanExpired();
    sessionRecovery.scanCancellationDeadlines();
    const recoveryInterval = setInterval(() => {
      try {
        sessionRecovery.scanExpired();
      } catch (error) {
        console.error(
          "Session recovery scan failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
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
    for (const queuedRun of workItemStore.listRunsByStatus(["queued"])) {
      void runExecutor.execute(queuedRun.id).catch(() => {});
    }
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
        flows: flowCatalog,
        capabilities: capabilityRegistry,
        approvals: approvalService,
        defaultCwd: config.workspaces?.default ?? config.workspaces?.root ?? process.cwd(),
      },
      config.runner.token,
    );
    const channelSessionIngress = createChannelSessionIngress(sessionCatalogApp, config.runner.token);
    bridge?.setSessionIngress(channelSessionIngress);
    telegram?.setSessionIngress(channelSessionIngress);
    const flowCatalogApp = createFlowApp(flowCatalog, config.runner.token, {
      sessions: sessionCatalog,
      events: workItemStore,
    });

    store.onChange((c) => {
      bridge?.updateConfig(c);
      telegram?.updateConfig(c);
    });

    const shutdown = async () => {
      await bridge?.disconnect();
      await telegram?.disconnect();
      approvalService.close();
      await mcpRuntime.close();
      mcpRegistry.close();
      capabilityRegistry.close();
      clearInterval(recoveryInterval);
      clearInterval(cancellationInterval);
      stopAgentHealthChecks();
      registry.close();
      projectDiscovery.close();
      sessionCatalog.close();
      flowCatalog.close();
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
        webFrontendApp,
        sessionCatalogApp,
        flowCatalogApp,
        mcpApp,
      ).fetch,
      hostname: "127.0.0.1",
      port: apiPort,
    });
    console.log(`Core API 监听 http://127.0.0.1:${apiPort}`);
    console.log(`Web: ${surfaces.web ? `enabled at http://127.0.0.1:${apiPort}/workbench/` : "disabled"}`);
    console.log(`Feishu: ${surfaces.feishu ? "enabled" : "disabled"}`);
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

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
