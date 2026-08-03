import type { AppConfig } from "@feishu-code-bridge/core";

export function hasFeishuCredentials(config: AppConfig): boolean {
  return (
    config.feishu.appId !== "cli_placeholder" &&
    config.feishu.appSecret !== "secret_placeholder"
  );
}

export function hasTelegramCredentials(config: AppConfig): boolean {
  return Boolean(config.telegram?.botToken);
}
