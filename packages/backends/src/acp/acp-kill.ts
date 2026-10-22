import type { ChildProcess } from "node:child_process";

/**
 * 杀掉 agent 子进程的整棵进程树。适配器链常有孙进程（如 codex-acp 底下的
 * `codex app-server`）：SIGTERM 会沿链转发、全树退出，但 SIGKILL 不转发——
 * 兜底升级到 SIGKILL 时只杀包装进程会把孙进程留成孤儿。因此 spawn 时用
 * `detached: true` 让子进程自成进程组，这里对整组（-pid）发信号；万一组
 * 信号失败（进程已死/平台差异）退回单进程 kill。
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 进程已不存在
    }
  }
}
