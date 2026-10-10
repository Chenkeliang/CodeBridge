import { inspect } from "node:util";

/** Same shape as the Feishu SDK's Logger; the SDK passes each call's arguments as one array. */
export interface SdkLogger {
  error: (...msg: unknown[]) => void;
  warn: (...msg: unknown[]) => void;
  info: (...msg: unknown[]) => void;
  debug: (...msg: unknown[]) => void;
  trace: (...msg: unknown[]) => void;
}

const REDACTED = "[REDACTED]";

/** Credential-shaped values the SDK puts in request bodies, headers and responses. */
const PATTERNS: Array<[RegExp, string]> = [
  [/((?:app_secret|appSecret|encrypt_key|verification_token)\\?["']?\s*[:=]\s*\\?["']?)[^"'\\\s,}]+/gi, `$1${REDACTED}`],
  [/((?:tenant|app|user)_access_token\\?["']?\s*[:=]\s*\\?["']?)[^"'\\\s,}]+/gi, `$1${REDACTED}`],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  // Tenant / user access tokens issued by Feishu.
  [/\b[tu]-[A-Za-z0-9_-]{20,}/g, REDACTED],
];

/** Render a value the way console would, then strip known secrets and credential patterns. */
export function redact(value: unknown, secrets: readonly (string | undefined)[]): string {
  let text = typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 120 });
  for (const secret of secrets) {
    if (secret && secret.length >= 8) text = text.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

/**
 * SDK logger that never writes credentials. The SDK's default logger dumps whole Axios
 * errors on network failures, including the token request body with app_secret.
 * `secrets` is read on every call so hot-reloaded config is honoured.
 */
export function redactingLogger(
  secrets: () => readonly (string | undefined)[],
  sink: Pick<Console, "log" | "warn" | "info" | "debug" | "trace"> = console,
): SdkLogger {
  const write = (level: string, out: (...args: unknown[]) => void) => (...msg: unknown[]) => {
    const values = secrets();
    out(`[${level}]:`, ...msg.map((item) => redact(item, values)));
  };
  // Mirror the SDK default: errors go to stdout (console.log), the rest to their console level.
  return {
    error: write("error", sink.log.bind(sink)),
    warn: write("warn", sink.warn.bind(sink)),
    info: write("info", sink.info.bind(sink)),
    debug: write("debug", sink.debug.bind(sink)),
    trace: write("trace", sink.trace.bind(sink)),
  };
}
