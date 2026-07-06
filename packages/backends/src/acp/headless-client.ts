import {
  client,
  methods,
  type ClientApp,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { AcpPermissionPolicy } from "@feishu-code-bridge/core";

export interface HeadlessClientOptions {
  permissionPolicy: AcpPermissionPolicy;
}

function pickAllowOption(
  params: RequestPermissionRequest,
): RequestPermissionResponse {
  const options = params.options ?? [];
  if (!options.length) {
    return {
      outcome: { outcome: "cancelled" },
    };
  }
  const allow =
    options.find((o) =>
      /allow|yes|approve|run|always/i.test(
        String(o.name ?? o.optionId ?? ""),
      ),
    ) ?? options[0]!;
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
