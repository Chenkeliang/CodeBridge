#!/usr/bin/env node
/**
 * 实况并发测试：向本机 Runner 同时发起 cursor + claude 两次 run。
 * 用法: node scripts/test-concurrency-live.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const configPath = path.join(
  os.homedir(),
  ".feishu-code-bridge",
  "config.yaml",
);
const raw = fs.readFileSync(configPath, "utf8");
const url = raw.match(/^\s*url:\s*(\S+)/m)?.[1];
const token = raw.match(/^\s*token:\s*(\S+)/m)?.[1];
if (!url || !token) {
  console.error("无法从 config.yaml 解析 runner.url / runner.token");
  process.exit(1);
}

const cwd = path.join(os.homedir(), "Projects", "feishu-code-bridge");
const prompt = "只回复一个词：OK";

async function runOnce(backendId, chatId) {
  const runId = randomUUID();
  const body = {
    runId,
    sessionKey: { chatId, backendId, cwd },
    prompt,
  };
  const started = Date.now();
  const res = await fetch(`${url.replace(/\/$/, "")}/runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${backendId} HTTP ${res.status}: ${await res.text()}`);
  }
  let text = "";
  let exitCode = 1;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      const event = JSON.parse(line.slice(5).trim());
      if (event.type === "text_delta") text += event.text;
      if (event.type === "done") exitCode = event.exitCode;
    }
  }
  return {
    backendId,
    chatId,
    ms: Date.now() - started,
    exitCode,
    text: text.trim().slice(0, 80),
  };
}

console.log("Runner:", url);
console.log("cwd:", cwd);
console.log("并行启动 cursor + claude …\n");

const started = Date.now();
const [cursor, claude] = await Promise.all([
  runOnce("cursor", "live-test-cursor"),
  runOnce("claude", "live-test-claude"),
]);
const total = Date.now() - started;

console.log("--- cursor ---");
console.log(cursor);
console.log("--- claude ---");
console.log(claude);
console.log("--- summary ---");
console.log({
  totalMs: total,
  parallelLikely: total < cursor.ms + claude.ms - 500,
  bothOk: cursor.exitCode === 0 && claude.exitCode === 0,
});
