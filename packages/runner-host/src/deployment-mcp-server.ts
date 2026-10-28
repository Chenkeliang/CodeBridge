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
  if (deployment) server.registerTool("codebridge_alert_status", {
    description: "更新当前告警原卡状态。需要定向核账提醒时传本群矩阵指定的 notify 姓名；由后端绑定原话题并校验群成员，不改变审批权限、不额外通知审批人。无需shell联网。",
    inputSchema: z.object({ status: z.enum(["investigating", "waiting", "resolved", "no_action", "blocked"]),
      summary: z.string().min(1).max(2000), notify: z.string().trim().min(1).max(100).optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    if (!deployment.runId || !deployment.token || !deployment.api) {
      return { isError: true, content: [{ type: "text", text: "告警工具缺少当前任务身份，已拒绝执行。" }] };
    }
    try {
      const response = await fetch(`${deployment.api}/outbound/alert-status`, { method: "POST",
        headers: { authorization: `Bearer ${deployment.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...input, runId: deployment.runId }), signal: AbortSignal.timeout(15_000) });
      return { isError: !response.ok, content: [{ type: "text", text: await response.text() }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "告警状态回写未确认成功；请检查同一任务状态后重试。" }] };
    }
  });
  if (deployment) server.registerTool("codebridge_followup", {
    description: "有截止时间的后台跟进。用户要求持续关注/稍后有结果通知时create：只提供查询目标prompt、名称和期限，不指定群/人ID/模型/权限；prompt须写明业务标识、查询入口、完成标准和所需Skill，因为每轮是新会话，不继承原始会话全文。原请求可先结束。notifyNames指定默认提醒姓名（不填=原发起人，空数组=不@），allowedNotifyNames列出可信群规则允许的其他姓名。后台只读查询后observe，并输出完整最终答复；summary只用于状态记录，不替换正文。等待不发消息，progress必须使用稳定key，completed/blocked自动停调度。后台不能创建新任务或管理其他计划；list/status/stop按真实发起人校验归属。创建成功后才承诺后台跟进，并告诉用户任务ID、截止时间及结果回原话题。",
    inputSchema: z.object({ action: z.enum(["create", "observe", "list", "status", "stop"]),
      taskId: z.string().regex(/^task_[A-Za-z0-9_]+$/).optional(), key: z.string().max(200).optional(),
      request: z.object({ name: z.string().min(1).max(100), prompt: z.string().min(1).max(64000), skills: z.array(z.string()).optional(),
        intervalMinutes: z.number().int().positive().optional(), timeoutMinutes: z.number().int().positive().optional(), notifyNames: z.array(z.string()).optional(), allowedNotifyNames: z.array(z.string()).optional() }).strict().optional(),
      observation: z.object({ status: z.enum(["waiting", "progress", "completed", "blocked"]), summary: z.string().min(1).max(2000),
        key: z.string().max(100).optional(), notifyNames: z.array(z.string()).optional(), caseStatus: z.enum(["resolved", "no_action", "waiting", "blocked"]).optional() }).strict().optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    if (!deployment.runId || !deployment.token || !deployment.api) return { isError: true, content: [{ type: "text", text: "跟进工具缺少当前Run身份，已拒绝执行。" }] };
    try {
      const headers = { authorization: `Bearer ${deployment.token}`, "content-type": "application/json", "x-codebridge-run-id": deployment.runId };
      const root = `${deployment.api}/v1/management/agent-tasks`;
      let response: Response;
      if (input.action === "list" || input.action === "status") {
        response = await fetch(root + (input.action === "status" && input.taskId ? `/${encodeURIComponent(input.taskId)}` : ""), { headers, signal: AbortSignal.timeout(15000) });
      } else {
        const read = await fetch(root, { headers, signal: AbortSignal.timeout(15000) });
        if (!read.ok) throw new Error("无法核对当前配置版本");
        const { revision } = await read.json() as { revision: string };
        Object.assign(headers, { "if-match": revision });
        let route: string, body: object;
        if (input.action === "create") {
          if (!input.request) throw new Error("创建跟进需要request");
          route = "/v1/management/followups"; body = { runId: deployment.runId, request: input.request, ...(input.key ? { key: input.key } : {}) };
        } else if (input.action === "observe") {
          if (!input.observation) throw new Error("上报需要observation");
          route = "/v1/management/followup-observation"; body = { runId: deployment.runId, observation: input.observation };
        } else {
          if (!input.taskId) throw new Error("停止需要taskId");
          route = "/v1/management/followup-stop"; body = { runId: deployment.runId, taskId: input.taskId };
        }
        response = await fetch(deployment.api + route, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      }
      return { isError: !response.ok, content: [{ type: "text", text: await response.text() }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `跟进操作未确认成功，请核对同一任务后重试：${error instanceof Error ? error.message.replaceAll(deployment.token, "[已隐藏]") : "接口不可用"}` }] };
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
