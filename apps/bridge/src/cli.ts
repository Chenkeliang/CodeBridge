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
  ProjectCatalogGitRepository,
  ProjectCatalogStore,
  ProjectDiscovery,
} from "@codebridge/project-catalog";
import { SessionCatalogStore, type AgentProfile } from "@codebridge/session-catalog";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { AgentRegistry } from "@codebridge/agent-registry";
import {
  McpRuntime,
  McpServerRegistry,
  SdkMcpClientFactory,
} from "@codebridge/mcp-runtime";
import { createProjectCatalogApp } from "./project-api.js";
import { createWebWorkbenchApp } from "./web-workbench.js";
import { createSessionApp } from "./session-api.js";
import { createFlowApp } from "./flow-api.js";
import { hasFeishuCredentials, hasTelegramCredentials } from "./channel-config.js";
import { createChannelSessionIngress } from "./channel-ingress.js";
import { createMcpApp } from "./mcp-api.js";

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
    const runExecutor = new RunExecutor(workItemStore, runnerClient, {
      approvals: approvalService,
      policy: policyEngine,
      capabilities: capabilityRuntime,
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
          resumeSessionId: linkedSession?.providerSessionId ?? undefined,
          additionalDirectories: linkedSession?.additionalDirectories,
        };
      },
    });
    // A process crash can leave a Run marked running. There is no in-memory
    // lease after restart, so move it back to the durable queue and resume it.
    for (const staleRun of workItemStore.listRunsByStatus(["running"])) {
      workItemStore.requeueRun(staleRun.id);
    }
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
    const knownAgents = ["codex", "pi", "cursor", "claude"];
    const agentIds = [...new Set([...knownAgents, ...Object.keys(config.backends)])];
    const registry = new AgentRegistry({ databasePath: path.join(dataDir, "agents.sqlite") });
    agentIds.forEach((agentId) => {
      const profile = config.backends[agentId];
      const displayNames: Record<string, string> = {
        codex: "Codex",
        pi: "Pi",
        cursor: "Cursor",
        claude: "Claude Code",
      };
      registry.register({
        agentId,
        displayName: displayNames[agentId] ?? agentId,
        adapter: agentId === "pi" ? "sdk" : profile?.type === "generic-spawn" ? "cli" : "acp",
        status: profile ? "healthy" : "needs_setup",
        capabilities: profile ? ["session", "workspace", "run"] : [],
        models: profile?.model ? [profile.model] : [],
        sessionFeatures: profile
          ? ["resume", "close", "delete", ...(profile.type === "pi-sdk" ? ["fork"] : [])]
          : [],
      });
    });
    const agentHealthAdapters = agentIds
      .filter((agentId) => Boolean(config.backends[agentId]))
      .map((agentId) => ({
        agentId,
        kind: registry.get(agentId)!.adapter,
        health: async () => (await runnerClient.health()).ok ? "healthy" as const : "unavailable" as const,
      }));
    await Promise.all(agentHealthAdapters.map((adapter) => registry.refresh(adapter)));
    const stopAgentHealthChecks = registry.startHealthChecks(agentHealthAdapters, 60_000);
    const agentProfiles: AgentProfile[] = registry.list();
    const webWorkbenchApp = createWebWorkbenchApp({
      store: workItemStore,
      token: config.runner.token,
      agents: agentProfiles.map((agent) => agent.agentId),
      agentProfiles: () => registry.list().map((agent) => ({
        id: agent.agentId,
        name: agent.displayName,
        status: agent.status,
        models: agent.models,
      })),
      workflows: [],
    });
    const sessionCatalogApp = createSessionApp(
      {
        catalog: sessionCatalog,
        agents: () => registry.list(),
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
        webWorkbenchApp,
        sessionCatalogApp,
        flowCatalogApp,
        mcpApp,
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
