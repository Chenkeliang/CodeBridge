import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { format } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { redact, redactingLogger } from "./redacting-logger.js";

const APP_SECRET = "7Hq2sEcReTvalueForTests123";
const RUNNER_TOKEN = "a5fd7dbd7587f0c502b2f7c4907d25af";

function sink() {
  const lines: string[] = [];
  // format() renders like console does (util.inspect), so nothing attached to an Error is hidden.
  const capture = (...args: unknown[]) => { lines.push(format(...args)); };
  return { lines, console: { log: capture, warn: capture, info: capture, debug: capture, trace: capture } };
}

describe("redacting SDK logger", () => {
  it("keeps app_secret out of the log when the SDK dumps a failed token request", async () => {
    // Same failure as production: DNS error while fetching tenant_access_token.
    const request = vi.fn(async (options: { url?: string; data?: unknown }) => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND open.feishu.cn"), {
        code: "ENOTFOUND",
        config: { method: "post", url: options.url, data: JSON.stringify(options.data), headers: { Authorization: "Bearer t-g1044abcdefghijklmnopqrstuvwxyz" } },
      });
    });
    const httpInstance = {
      request,
      get: (url: string, opts?: object) => request({ ...opts, url }),
      delete: (url: string, opts?: object) => request({ ...opts, url }),
      head: (url: string, opts?: object) => request({ ...opts, url }),
      options: (url: string, opts?: object) => request({ ...opts, url }),
      post: (url: string, data?: unknown, opts?: object) => request({ ...opts, url, data }),
      put: (url: string, data?: unknown, opts?: object) => request({ ...opts, url, data }),
      patch: (url: string, data?: unknown, opts?: object) => request({ ...opts, url, data }),
    };
    const out = sink();
    const client = new Client({
      appId: "cli_test", appSecret: APP_SECRET, loggerLevel: LoggerLevel.info,
      logger: redactingLogger(() => [APP_SECRET], out.console),
      httpInstance: httpInstance as never,
    });
    await client.im.v1.chat.list({}).catch(() => undefined);

    const tokenCall = request.mock.calls.find(([options]) => String(options.url).includes("tenant_access_token"));
    expect(JSON.stringify(tokenCall?.[0].data)).toContain(APP_SECRET); // the SDK really sent it
    const log = out.lines.join("\n");
    expect(log).toContain("ENOTFOUND"); // the error is still logged
    expect(log).not.toContain(APP_SECRET);
    expect(log).not.toContain("t-g1044abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts known secrets anywhere and credential-shaped fields by name", () => {
    const secrets = [APP_SECRET, RUNNER_TOKEN, undefined, "short"];
    expect(redact({ nested: { deep: { value: `x${APP_SECRET}y` } } }, secrets)).not.toContain(APP_SECRET);
    expect(redact(`runner ${RUNNER_TOKEN}`, secrets)).toBe("runner [REDACTED]");
    expect(redact(`data: '{"app_id":"cli_x","app_secret":"other-unknown-secret"}'`, secrets))
      .toBe(`data: '{"app_id":"cli_x","app_secret":"[REDACTED]"}'`);
    expect(redact('{"tenant_access_token":"t-abcdefghijklmnopqrstuvwxyz0123","expire":7200}', secrets))
      .toBe('{"tenant_access_token":"[REDACTED]","expire":7200}');
    expect(redact("Authorization: Bearer u-abc.def_ghi", secrets)).toBe("Authorization: Bearer [REDACTED]");
    // Ordinary content is left alone, and values shorter than 8 chars are not treated as secrets.
    expect(redact("message om_x100b63 delivered, short", secrets)).toBe("message om_x100b63 delivered, short");
  });

  it("matches the SDK default's levels and prefixes", () => {
    const out = { log: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
    const logger = redactingLogger(() => [], out);
    logger.error(["boom"]);
    logger.info(["hello"]);
    expect(out.log).toHaveBeenCalledWith("[error]:", "[ 'boom' ]");
    expect(out.info).toHaveBeenCalledWith("[info]:", "[ 'hello' ]");
  });
});
