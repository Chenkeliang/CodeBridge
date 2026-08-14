import fs from "node:fs";
import path from "node:path";

export interface WorkspaceKeyResult {
  key: string;
  diagnostic?: string;
}

/**
 * 规范化工作目录为稳定的槽位键。
 * - 成功：realpath 解析符号链接，去尾部斜杠；
 * - 失败（目录已删等）：回退到 path.resolve 规范化绝对路径，并记录诊断，不抛错。
 */
export function canonicalWorkspaceKey(cwd: string): WorkspaceKeyResult {
  const normalized = path.resolve(cwd);
  try {
    return { key: fs.realpathSync(normalized).replace(/[\\/]+$/, "") };
  } catch (error) {
    return {
      key: normalized.replace(/[\\/]+$/, ""),
      diagnostic: `workspace realpath failed (${
        error instanceof Error ? error.message : String(error)
      }), falling back to resolved path`,
    };
  }
}
