import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeClaudeProjectDir } from "../session-discovery.js";

/**
 * claude 会话的磁盘活动标记（drain 精确信号，借鉴 codeg 的 background-watch 思路）：
 * 后台子 agent 的输出写在 `<projectDir>/<sessionId>/subagents/*.jsonl`（独立文件，
 * ACP wire 上可能长时间静默），唤醒与汇总写回主 `<sessionId>.jsonl`。两者合计字节数
 * 单调递增，任何增长都代表后台仍在工作——drain 用它刷新静默计时，避免子 agent
 * 静默期超过 quiet 窗被误切。读取失败返回 undefined（不影响 wire 信号）。
 */
export function createClaudeSessionActivityMarker(
  cwd: string,
  sessionId: string,
): () => number | undefined {
  const projectDir = path.join(
    os.homedir(),
    ".claude",
    "projects",
    encodeClaudeProjectDir(cwd),
  );
  const mainFile = path.join(projectDir, `${sessionId}.jsonl`);
  const sessionDir = path.join(projectDir, sessionId);
  return () => {
    let total: number | undefined;
    try {
      total = fs.statSync(mainFile).size;
    } catch {
      // 主文件还没建（会话尚未写盘）
    }
    try {
      const stack = [sessionDir];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else {
            try {
              total = (total ?? 0) + fs.statSync(full).size;
            } catch {
              // 文件在 stat 前被移走，忽略
            }
          }
        }
      }
    } catch {
      // 子目录不存在（无后台子 agent）
    }
    return total;
  };
}
