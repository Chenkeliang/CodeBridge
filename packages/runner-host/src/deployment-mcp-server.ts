import path from "node:path";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { StdioMcpServerConfig } from "@codebridge/core";
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


export function createDeploymentMcpServer(deployment?: DeploymentMcpContext): McpServer {
  const server = new McpServer({ name: "codebridge-internal", version: "1.0.0" });
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
export function createDeploymentMcpServerConfig(scriptPath: string, deployment: DeploymentMcpContext): StdioMcpServerConfig {
  if (!path.isAbsolute(scriptPath)) throw new Error("Internal MCP server path must be absolute");
  return { name: "codebridge-internal", command: process.execPath, args: [scriptPath],
    env: { FCB_API: deployment.api, FCB_TOKEN: deployment.token, FCB_RUN_ID: deployment.runId } };
}
async function main(): Promise<void> {
  const server = createDeploymentMcpServer(process.env.FCB_API === undefined ? undefined : {
    api: process.env.FCB_API, token: process.env.FCB_TOKEN ?? "", runId: process.env.FCB_RUN_ID ?? "",
  });
  await server.connect(new StdioServerTransport());
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
