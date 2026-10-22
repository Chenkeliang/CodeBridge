import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const TASK_COMMAND_HELP = `CodeBridge任务命令（配置检查版本，执行与补发使用持久幂等标识）
  tasks list
  tasks show <任务ID>
  tasks runs <任务ID> [--offset <数量>]
  tasks preflight --file <任务JSON>
  tasks create --file <任务JSON>       默认保存为暂停状态
  tasks edit <任务ID> --file <任务JSON>
  tasks pause|resume|run <任务ID> [--acknowledge-unknown] [--key <操作标识>]
  tasks result <任务ID> <运行记录ID>
  tasks retry|resend|acknowledge <任务ID> <运行记录ID> [--acknowledge-unknown] [--key <操作标识>]
  tasks output <文件路径>              仅登记当前正在执行的任务结果，不发送消息
任务JSON必填：name、prompt、agentId、cwd、schedule、timezone；可选skills、model、effort、permissionMode、target、notification、catchUp、enabled。
例：schedule可填“每天09:00”“每30分钟”“30分钟后”或五段Cron。target默认仅本地，通知默认最终结果。
retry创建新会话重新执行；resend只发送已保存结果。acknowledge只在人核对后标记无需补发，不代表平台已读。结果不明时须先核对，再显式使用--acknowledge-unknown。`;

/** Shared by the installed CLI and the actual fcb injected into Agent PATH. */
export async function runTaskCommand(args: string[], context: { api: string; token: string; runId?: string; fetch?: typeof fetch }): Promise<unknown> {
  if (!args.length || ["help", "--help", "-h"].includes(args[0]!)) return { help: TASK_COMMAND_HELP };
  const [action, ...rest] = args;
  const positionals: string[] = [], flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i]!;
    if (value === "--acknowledge-unknown") flags.acknowledge = true;
    else if (["--file", "--key", "--offset", "--run-id"].includes(value) && rest[i + 1] && !rest[i + 1]!.startsWith("--")) flags[value.slice(2)] = rest[++i]!;
    else if (value.startsWith("--")) throw new Error(`未识别的任务参数：${value}`);
    else positionals.push(value);
  }
  if (!["list", "show", "runs", "result", "output", "create", "edit", "preflight", "pause", "resume", "run", "retry", "resend", "acknowledge"].includes(action!)) throw new Error("未知任务命令，请运行tasks help查看完整用法");
  const endpoint = new URL(context.api);
  if (!["http:", "https:"].includes(endpoint.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("任务管理仅连接本机Bridge地址");
  const fetchImpl = context.fetch ?? globalThis.fetch;
  const base = context.api.replace(/\/$/, "");
  const read = async (route: string, method = "GET", body?: unknown, revision?: string): Promise<any> => {
    const response = await fetchImpl(base + route, { method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${context.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(revision ? { "if-match": revision } : {}),
        ...(method !== "GET" ? { "idempotency-key": String(flags.key ?? actionId) } : {}), ...(context.runId ? { "x-codebridge-run-id": context.runId } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new Error(`${response.status} ${value?.message ?? value?.error ?? "任务请求未完成"}`.replaceAll(context.token, "[已隐藏]"));
    return value;
  };
  const actionId = randomUUID(), root = "/v1/management/agent-tasks";
  const taskId = positionals[0], attemptId = positionals[1];
  const requireTask = () => { if (!taskId || !/^task_[A-Za-z0-9_]+$/.test(taskId)) throw new Error("请提供有效的任务ID，可先运行tasks list"); return `${root}/${encodeURIComponent(taskId)}`; };
  const requireAttempt = () => { if (!attemptId || !/^taskrun_[A-Za-z0-9_]+$/.test(attemptId)) throw new Error("请提供该任务下的运行记录ID"); return `${requireTask()}/runs/${encodeURIComponent(attemptId)}`; };
  if (action === "list") return read(root);
  if (action === "show" || action === "runs") return read(requireTask() + (flags.offset !== undefined ? `?offset=${encodeURIComponent(String(flags.offset))}` : ""));
  if (action === "result") return read(requireAttempt());
  const revision = (await read(root)).revision;
  if (action === "output") {
    const runId = context.runId ?? (typeof flags["run-id"] === "string" ? flags["run-id"] : undefined);
    if (!runId || !positionals[0]) throw new Error("登记结果需要当前FCB_RUN_ID和项目内文件路径；本机维护者可显式提供--run-id");
    return read("/v1/management/agent-task-output", "POST", { runId, path: path.resolve(positionals[0]) }, revision);
  }
  if (["create", "edit", "preflight"].includes(action!)) {
    if (typeof flags.file !== "string") throw new Error("请使用--file提供任务JSON文件");
    const draft = JSON.parse(fs.readFileSync(flags.file, "utf8"));
    if (action === "preflight") return read(`${root}/preflight`, "POST", draft, revision);
    if (action === "create") return read(root, "POST", draft, revision);
    const current = await read(requireTask());
    return read(requireTask(), "PUT", { version: current.task.version, task: draft }, revision);
  }
  if (["pause", "resume", "run", "retry", "resend", "acknowledge"].includes(action!)) {
    const current = await read(requireTask());
    const body = { version: current.task.version, acknowledgeUnknown: flags.acknowledge === true };
    if (action === "retry" || action === "resend" || action === "acknowledge") return read(`${requireAttempt()}/${action}`, "POST", body, revision);
    return read(`${requireTask()}/${action}`, "POST", body, revision);
  }
  throw new Error("未知任务命令，请运行tasks help查看完整用法");
}
