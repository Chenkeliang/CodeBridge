import path from "node:path";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  FLOW_SAVE_AVAILABILITY_ENV,
  FLOW_SAVE_NO_SOURCE_MESSAGE,
  FLOW_SAVE_TOOL_DESCRIPTION,
  FLOW_SAVE_TOOL_NAME,
  RequestFlowSaveInputSchema,
  flowSaveToolOutput,
  parseRequestFlowSaveInput,
  type FlowSaveSourceAvailability,
  type StdioMcpServerConfig,
} from "@codebridge/core";

export interface DeploymentMcpContext {
  api: string;
  token: string;
  runId: string;
}

const DeploymentInputSchema = z.object({
  action: z.enum(["prepare", "publish", "status", "cancel", "rollback"]),
  ref: z.string().optional(),
  releaseId: z.string().optional(),
  publishAfterPrepare: z.boolean().optional(),
}).strict();

export function createFlowSaveMcpServer(
  availability?: FlowSaveSourceAvailability,
  deployment?: DeploymentMcpContext,
): McpServer {
  const server = new McpServer({
    name: "codebridge-internal",
    version: "1.0.0",
  });
  if (availability) server.registerTool(FLOW_SAVE_TOOL_NAME, {
    description: FLOW_SAVE_TOOL_DESCRIPTION,
    inputSchema: RequestFlowSaveInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input) => {
    parseRequestFlowSaveInput(input);
    const output = flowSaveToolOutput(availability);
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: { ...output },
    };
  });
  if (deployment) server.registerTool("codebridge_deploy", {
    description: "CodeBridge 安全发布：准备候选、按用户明确授权上线、查询状态、取消或回滚。身份由当前任务绑定；无需 shell 网络或放宽沙箱。发布与回滚仍由 Bridge 校验飞书原始授权。",
    inputSchema: DeploymentInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    if (!deployment.runId || !deployment.token || !deployment.api) {
      return { isError: true, content: [{ type: "text", text: "发布工具缺少当前任务身份或连接配置，已拒绝执行。" }] };
    }
    try {
      const response = await fetch(`${deployment.api}/deploy/command`, {
        method: "POST",
        headers: { authorization: `Bearer ${deployment.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...DeploymentInputSchema.parse(input), runId: deployment.runId }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      return { isError: !response.ok, content: [{ type: "text", text }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "暂时联系不上本机 Bridge 发布接口，请稍后重试。" }] };
    }
  });
  return server;
}

export function createFlowSaveMcpServerConfig(
  scriptPath: string,
  availability?: FlowSaveSourceAvailability,
  deployment?: DeploymentMcpContext,
): StdioMcpServerConfig {
  if (!path.isAbsolute(scriptPath)) {
    throw new Error("Flow save MCP server path must be absolute");
  }
  return {
    name: "codebridge-internal",
    command: process.execPath,
    args: [scriptPath],
    env: {
      ...(availability ? { [FLOW_SAVE_AVAILABILITY_ENV]: availability.available ? "true" : "false" } : {}),
      ...(deployment ? { FCB_API: deployment.api, FCB_TOKEN: deployment.token, FCB_RUN_ID: deployment.runId } : {}),
    },
  };
}

export function readFlowSaveAvailabilityFromEnv(
  env: NodeJS.ProcessEnv,
): FlowSaveSourceAvailability {
  const raw = env[FLOW_SAVE_AVAILABILITY_ENV];
  if (raw === "true") return { available: true };
  if (raw === "false") {
    return {
      available: false,
      code: "no_extractable_previous_run",
      message: FLOW_SAVE_NO_SOURCE_MESSAGE,
    };
  }
  throw new Error(`Missing or invalid ${FLOW_SAVE_AVAILABILITY_ENV}`);
}

async function main(): Promise<void> {
  const server = createFlowSaveMcpServer(
    process.env[FLOW_SAVE_AVAILABILITY_ENV] === undefined ? undefined : readFlowSaveAvailabilityFromEnv(process.env),
    process.env.FCB_API === undefined ? undefined : {
      api: process.env.FCB_API,
      token: process.env.FCB_TOKEN ?? "",
      runId: process.env.FCB_RUN_ID ?? "",
    },
  );
  await server.connect(new StdioServerTransport());
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
