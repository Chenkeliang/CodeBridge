import type { AppConfig } from "@codebridge/core";
import { hasFeishuCredentials, hasTelegramCredentials } from "./channel-config.js";

export interface StartupSurfaces {
  web: boolean;
  feishu: boolean;
  telegram: boolean;
}

export interface StartupOverrides {
  web?: boolean;
}

/**
 * Entrances are independent. The Core API may run with no channel and Web is
 * opt-in so a headless install does not open a browser surface accidentally.
 */
export function resolveStartupSurfaces(config: AppConfig, overrides: StartupOverrides = {}): StartupSurfaces {
  return {
    web: overrides.web ?? config.web.enabled,
    feishu: hasFeishuCredentials(config),
    telegram: hasTelegramCredentials(config),
  };
}
