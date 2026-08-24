import fs from "node:fs/promises";
import path from "node:path";

/**
 * fcb — 注入到 Agent 子进程 PATH 的小命令，通过 Bridge 出站 API
 * 把文件/消息发回当前飞书聊天。纯 node 实现，无外部依赖。
 */
const FCB_SCRIPT = `#!/usr/bin/env node
// fcb — 在 CodeBridge Agent 任务里把文件/消息发回当前聊天
// 用法: fcb send <文件路径> | fcb say <消息> | fcb mention <对象引用> <消息> | fcb flow suggest ... | fcb flow batch <draft-json-file>
const path = require("node:path");
const fs = require("node:fs");

const api = process.env.FCB_API;
const token = process.env.FCB_TOKEN;
const chatId = process.env.FCB_CHAT_ID;
const topicId = process.env.FCB_TOPIC_ID;
const runId = process.env.FCB_RUN_ID;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function post(route, body) {
  const res = await fetch(api + route, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail("fcb: " + res.status + " " + text);
  console.log(text);
}

async function main() {
  if (!api || !token || !chatId) {
    fail("fcb: 缺少 FCB_API/FCB_TOKEN/FCB_CHAT_ID（仅在 CodeBridge 任务中可用）");
  }
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "send" && rest[0]) {
    await post("/outbound/file", {
      chatId,
      topicId,
      path: path.resolve(rest[0]),
    });
  } else if (cmd === "say" && rest.length) {
    await post("/outbound/markdown", {
      chatId,
      topicId,
      markdown: rest.join(" "),
    });
  } else if (cmd === "mention" && rest[0] && rest.length > 1) {
    await post("/outbound/mention", {
      chatId,
      topicId,
      ref: rest[0],
      text: rest.slice(1).join(" "),
    });
  } else if (cmd === "flow" && rest[0] === "batch" && rest[1]) {
    if (!runId) fail("fcb: 缺少 FCB_RUN_ID，不能提交 Flow 批量草稿");
    const draftPath = path.resolve(rest[1]);
    const stat = fs.statSync(draftPath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
      fail("fcb: Flow 批量草稿必须是 2 MiB 以内的 JSON 文件");
    }
    const draft = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
      fail("fcb: Flow 批量草稿必须是 JSON 对象");
    }
    if (!draft.flow_id || !draft.definition_revision || !Array.isArray(draft.items)) {
      fail("fcb: Flow 批量草稿缺少 flow_id、definition_revision 或 items");
    }
    if (draft.items.length < 1 || draft.items.length > 500) {
      fail("fcb: Flow 批量草稿 items 必须为 1–500 项");
    }
    delete draft.session_id;
    draft.source_run_id = runId;
    await post("/v1/flow-invocation-drafts", draft);
  } else if (cmd === "flow" && rest[0] === "suggest" && rest[1] && rest[2]) {
    const [subcommand, flowId, definitionRevision, ...options] = rest;
    const reasonIndex = options.indexOf("--reason");
    const assignments = reasonIndex >= 0 ? options.slice(0, reasonIndex) : options;
    const reason = reasonIndex >= 0 ? options.slice(reasonIndex + 1).join(" ") : "";
    const extractedInputs = {};
    for (const assignment of assignments) {
      const equals = assignment.indexOf("=");
      if (equals <= 0) continue;
      const key = assignment.slice(0, equals);
      const raw = assignment.slice(equals + 1);
      extractedInputs[key] = /^-?\\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
        ? Number(raw)
        : raw;
    }
    if (!runId) fail("fcb: 缺少 FCB_RUN_ID，不能提交 Flow 建议");
    await post("/v1/flows/recommendations", {
      run_id: runId,
      flow_id: flowId,
      definition_revision: definitionRevision,
      reason,
      extracted_inputs: extractedInputs,
    });
  } else {
    fail("用法: fcb send <文件路径> | fcb say <消息> | fcb mention <对象引用> <消息> | fcb flow suggest <Flow ID> <revision> [参数=值] [--reason 原因] | fcb flow batch <draft-json-file>");
  }
}

main().catch((err) => fail("fcb: " + (err instanceof Error ? err.message : String(err))));
`;

/** 把 fcb 写入 <dataDir>/bin/fcb 并加执行位，返回 bin 目录 */
export async function writeFcbScript(dataDir: string): Promise<string> {
  const binDir = path.join(dataDir, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const file = path.join(binDir, "fcb");
  await fs.writeFile(file, FCB_SCRIPT, { mode: 0o755 });
  await fs.chmod(file, 0o755);
  return binDir;
}
