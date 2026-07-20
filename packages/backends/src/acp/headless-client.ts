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
  /**
   * prompt_feishu 模式的决策等待器：把权限请求交给外界（飞书 /approve /deny），
   * resolve true=允许 false=拒绝（含超时）。未提供时 prompt_feishu 退化为拒绝。
   */
  requestDecision?: (info: { title: string }) => Promise<boolean>;
}

/** 从权限请求里提取给用户看的操作描述 */
export function permissionRequestTitle(
  params: RequestPermissionRequest,
): string {
  const toolCall = params.toolCall as
    | { title?: string; kind?: string }
    | undefined;
  return toolCall?.title || toolCall?.kind || "工具操作";
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
    .onRequest(methods.client.session.requestPermission, async (ctx) => {
      if (options.permissionPolicy === "auto_allow") {
        return pickAllowOption(ctx.params);
      }
      if (
        options.permissionPolicy === "prompt_feishu" &&
        options.requestDecision
      ) {
        const approved = await options.requestDecision({
          title: permissionRequestTitle(ctx.params),
        });
        return approved
          ? pickAllowOption(ctx.params)
          : { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "cancelled" } };
    });
}
