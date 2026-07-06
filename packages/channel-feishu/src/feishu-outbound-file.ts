import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 飞书文件消息上限 30MB */
export const MAX_OUTBOUND_FILE_BYTES = 30 * 1024 * 1024;

export interface OutboundFile {
  path: string;
  fileName: string;
}

/**
 * 校验 /send 要外发的本地文件：仅允许主目录内的普通文件，
 * 防止把系统文件或目录发进聊天。
 */
export async function resolveOutboundFile(
  raw: string,
  homeDir: string = os.homedir(),
): Promise<OutboundFile> {
  const expanded =
    raw === "~" || raw.startsWith("~/")
      ? path.join(homeDir, raw.slice(1))
      : raw;
  if (!path.isAbsolute(expanded)) {
    throw new Error("请提供绝对路径（可用 `~/` 开头）");
  }

  let real: string;
  try {
    real = await fs.realpath(expanded);
  } catch {
    throw new Error(`文件不存在: ${expanded}`);
  }

  const realHome = await fs.realpath(homeDir);
  const rel = path.relative(realHome, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("仅允许发送主目录内的文件");
  }

  const stat = await fs.stat(real);
  if (!stat.isFile()) {
    throw new Error("目标不是普通文件");
  }
  if (stat.size > MAX_OUTBOUND_FILE_BYTES) {
    throw new Error(
      `文件超过飞书 30MB 上限（实际 ${(stat.size / 1024 / 1024).toFixed(1)}MB）`,
    );
  }

  return { path: real, fileName: path.basename(real) };
}
