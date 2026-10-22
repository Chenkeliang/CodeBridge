import { beforeEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { FeishuCli } from "./feishu-cli.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const input = vi.fn();
const cli = new FeishuCli({ dataDir: "/tmp/feishu-cli-test", appId: "cli_bot", appSecret: "secret-fixture", domain: "https://open.feishu.cn" });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(execFile).mockImplementation(((_command: unknown, _args: unknown, _options: unknown, callback: (error: unknown, stdout: string) => void) => {
  queueMicrotask(() => callback(null, JSON.stringify({ ok: true, access_token: "private-token" })));
  return { stdin: { end: input } };
}) as never); });

it("configures the existing app via stdin in an isolated CLI profile and redacts token output", async () => {
  expect(await cli.setup()).toEqual({ ok: true, access_token: "[REDACTED]" });
  const call = vi.mocked(execFile).mock.calls[0]!;
  expect(JSON.stringify(call[1])).not.toContain("secret-fixture");
  expect(call[1]).toEqual(expect.arrayContaining(["config", "init", "--app-id", "cli_bot", "--app-secret-stdin", "--name", "codebridge"]));
  expect(input).toHaveBeenCalledWith("secret-fixture");
  expect(call[2]).toMatchObject({ env: { LARKSUITE_CLI_CONFIG_DIR: "/tmp/feishu-cli-test/feishu-cli" } });
});

it("uses split authorization with explicit scopes and completes only with a supplied device code", async () => {
  await cli.beginAuthorization();
  expect(vi.mocked(execFile).mock.calls[0]![1]).toEqual(expect.arrayContaining(["--profile", "codebridge", "auth", "login", "--scope", "contact:user:search", "--no-wait", "--json"]));
  await cli.completeAuthorization("device-code");
  expect(vi.mocked(execFile).mock.calls[1]![1]).toEqual(expect.arrayContaining(["--device-code", "device-code"]));
  await expect(cli.completeAuthorization("")).rejects.toThrow("授权码无效");
});

it("keeps bot group lookup and authorized user directory search as explicit separate identities", async () => {
  await cli.members("oc_alert");
  expect(vi.mocked(execFile).mock.calls[0]![1]).toEqual(expect.arrayContaining(["--as", "bot", "--chat-id", "oc_alert"]));
  await cli.searchUser("示例成员甲");
  expect(vi.mocked(execFile).mock.calls[1]![1]).toEqual(expect.arrayContaining(["--as", "user", "--query", "示例成员甲"]));
});

it("generates an authorization QR using the original URL and a relative output path", async () => {
  const url = "https://open.feishu.cn/auth?device=a%2Bb";
  const result = await cli.authorizationQr(url);
  expect(result.url).toBe(url);
  expect(result.qrCodePath).toMatch(/^\/tmp\/feishu-cli-test\/feishu-cli\/authorization-\d+\.png$/);
  expect(vi.mocked(execFile).mock.calls[0]![1]).toEqual(expect.arrayContaining(["auth", "qrcode", url, "--output"]));
  await expect(cli.authorizationQr("https://unrelated.example/auth")).rejects.toThrow("官方授权链接");
});
