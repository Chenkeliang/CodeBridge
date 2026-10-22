import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export const FEISHU_CLI_VERSION = "1.0.98";
const require = createRequire(import.meta.url);

/** Official CLI, isolated from personal profiles; app secrets never enter argv or output. */
export class FeishuCli {
  constructor(private readonly options: { dataDir: string; appId: string; appSecret: string; domain: string }) {}

  private execute(args: string[], input?: string): Promise<string> {
    const launcher = require.resolve("@larksuite/cli/scripts/run.js");
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [launcher, ...args], {
        timeout: 120_000, maxBuffer: 4 * 1024 * 1024, cwd: this.options.dataDir,
        env: { ...process.env, LARKSUITE_CLI_CONFIG_DIR: path.join(this.options.dataDir, "feishu-cli"),
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
      }, (error, stdout) => {
        if (error && !stdout.trim().startsWith("{")) return reject(new Error(`飞书 CLI 执行失败（${error.code ?? "unknown"}），请运行 codebridge feishu-cli install/setup 检查安装与配置`));
        resolve(stdout.replaceAll(this.options.appSecret, "[REDACTED]"));
      });
      child.stdin?.end(input ?? "");
    });
  }

  private async json(args: string[], input?: string): Promise<unknown> {
    const result = JSON.parse(await this.execute(args, input)) as unknown;
    // CLI owns tokens in its keychain. Never return them to the Agent or terminal.
    return JSON.parse(JSON.stringify(result, (key, value) => /^(?:app_?secret|access_?token|refresh_?token|tenant_?access_?token|user_?access_?token)$/i.test(key) ? "[REDACTED]" : value));
  }

  async install(): Promise<{ version: string }> {
    return { version: (await this.execute(["--version"])).trim() };
  }

  async setup(): Promise<unknown> {
    return this.json(["config", "init", "--name", "codebridge", "--app-id", this.options.appId,
      "--app-secret-stdin", "--brand", new URL(this.options.domain).hostname === "open.larksuite.com" ? "lark" : "feishu"], this.options.appSecret);
  }

  async authStatus(): Promise<unknown> {
    return this.json(["--profile", "codebridge", "auth", "status", "--verify", "--json"]);
  }

  async beginAuthorization(scope = "contact:user:search"): Promise<unknown> {
    if (!/^[a-z][a-z0-9_:., -]{0,1000}$/i.test(scope) || /\b(?:all|offline_access)\b/.test(scope)) throw new Error("请明确指定所需业务 scope，不申请全量权限");
    return this.json(["--profile", "codebridge", "auth", "login", "--scope", scope, "--no-wait", "--json"]);
  }

  async authorizationQr(verificationUrl: string): Promise<{ url: string; qrCodePath: string }> {
    const url = new URL(verificationUrl);
    if (url.protocol !== "https:" || !["feishu.cn", "larksuite.com"].some((domain) => url.hostname === domain || url.hostname.endsWith("." + domain))) throw new Error("请使用飞书 CLI 返回的官方授权链接");
    const output = `feishu-cli/authorization-${Date.now()}.png`;
    await this.execute(["auth", "qrcode", verificationUrl, "--output", output]);
    return { url: verificationUrl, qrCodePath: path.join(this.options.dataDir, output) };
  }

  async completeAuthorization(deviceCode: string): Promise<unknown> {
    if (!deviceCode.trim() || deviceCode.length > 4096) throw new Error("授权码无效");
    return this.json(["--profile", "codebridge", "auth", "login", "--device-code", deviceCode, "--json"]);
  }

  async members(chatId: string): Promise<unknown> {
    if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw new Error("飞书群 ID 无效");
    return this.json(["--profile", "codebridge", "im", "+chat-members-list", "--chat-id", chatId,
      "--member-types", "user", "--page-all", "--page-limit", "20", "--as", "bot"]);
  }

  async searchUser(query: string): Promise<unknown> {
    if (!query.trim() || query.length > 50) throw new Error("请提供明确姓名（最多50字）");
    return this.json(["--profile", "codebridge", "contact", "+search-user", "--query", query, "--as", "user"]);
  }
}
