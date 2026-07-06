import fs from "node:fs/promises";
import path from "node:path";

/**
 * fcb — 注入到 Agent 子进程 PATH 的小命令，通过 Bridge 出站 API
 * 把文件/消息发回当前飞书聊天。纯 node 实现，无外部依赖。
 */
const FCB_SCRIPT = `#!/usr/bin/env node
// fcb — 在飞书码桥 Agent 任务里把文件/消息发回当前聊天
// 用法: fcb send <文件路径> | fcb say <消息>
const path = require("node:path");

const api = process.env.FCB_API;
const token = process.env.FCB_TOKEN;
const chatId = process.env.FCB_CHAT_ID;
const topicId = process.env.FCB_TOPIC_ID;

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
    fail("fcb: 缺少 FCB_API/FCB_TOKEN/FCB_CHAT_ID（仅在飞书码桥任务中可用）");
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
  } else {
    fail("用法: fcb send <文件路径> | fcb say <消息>");
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
