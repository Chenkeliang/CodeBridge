import {
  client,
  methods,
  type ClientApp,
  type PermissionOptionKind,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { AcpPermissionPolicy } from "@feishu-code-bridge/core";

export interface HeadlessClientOptions {
  permissionPolicy: AcpPermissionPolicy;
}

export function pickAllowOption(
  params: RequestPermissionRequest,
): RequestPermissionResponse {
  const options = params.options ?? [];
  const byKind = (kind: PermissionOptionKind) =>
    options.find((o) => o.kind === kind);
  const allow = byKind("allow_once") ?? byKind("allow_always");
  if (!allow) {
    return {
      outcome: { outcome: "cancelled" },
    };
  }
  return {
    outcome: {
      outcome: "selected",
      optionId: allow.optionId,
    },
  };
}

/** 流式 session/update 由 ActiveSession.nextUpdate() 接收，此处只处理权限 */
export function createHeadlessClientApp(
  options: HeadlessClientOptions,
): ClientApp {
  return client({ name: "feishu-code-bridge" })
    .onRequest(methods.client.session.requestPermission, (ctx) => {
      if (options.permissionPolicy === "auto_allow") {
        return pickAllowOption(ctx.params);
      }
      return { outcome: { outcome: "cancelled" } };
    });
}
