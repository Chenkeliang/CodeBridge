export class AcpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpTimeoutError";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** 轮询 abort + 总超时，避免 session/load 等 RPC 永久挂起 */
export async function raceWithAbort<T>(
  promise: Promise<T>,
  isAborted: () => boolean,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (isAborted()) {
      throw new Error("aborted");
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AcpTimeoutError(timeoutMessage);
    }
    const result = await Promise.race([
      promise,
      sleep(Math.min(remaining, 40)).then(() => "tick" as const),
    ]);
    if (result !== "tick") return result;
  }
}
