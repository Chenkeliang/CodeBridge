const CHECK_INTERVAL_MS = 1_000;
const STALL_THRESHOLD_MS = 5_000;

/** 纯函数：给定两次 tick 之间的实际耗时，判断是否构成一次事件循环停顿告警。 */
export function detectEventLoopStall(
  actualElapsedMs: number,
  expectedElapsedMs: number = CHECK_INTERVAL_MS,
  thresholdMs: number = STALL_THRESHOLD_MS,
): { stalled: boolean; lagMs: number } {
  const lagMs = actualElapsedMs - expectedElapsedMs;
  return { stalled: lagMs >= thresholdMs, lagMs };
}

/**
 * 每秒检测一次事件循环是否被同步任务阻塞。心跳续租和 recovery 扫描都依赖
 * 事件循环按时运转；一旦停顿超过阈值，先记录下来，方便定位「租约看似过期
 * 但进程其实一直健康」这类假死场景的根因。
 */
export function startEventLoopLagMonitor(
  options: {
    now?: () => number;
    warn?: (line: string) => void;
    intervalMs?: number;
    thresholdMs?: number;
  } = {},
): { stop: () => void } {
  const now = options.now ?? (() => Date.now());
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  const thresholdMs = options.thresholdMs ?? STALL_THRESHOLD_MS;

  let lastTick = now();
  const timer = setInterval(() => {
    const current = now();
    const actualElapsedMs = current - lastTick;
    lastTick = current;
    const { stalled, lagMs } = detectEventLoopStall(
      actualElapsedMs,
      intervalMs,
      thresholdMs,
    );
    if (stalled) {
      warn(`${new Date().toISOString()} event_loop_stall lagMs=${lagMs}`);
    }
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
