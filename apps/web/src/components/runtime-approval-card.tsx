import { Check, Clock3, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TimelineBlockView } from "@/lib/types";
import { cn } from "@/lib/utils";

export type RuntimeApprovalStatus =
  | "requested"
  | "granted"
  | "rejected"
  | "expired";

export type RuntimeApprovalAction = {
  runId: string;
  approvalId: string;
};

function stringMetadata(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value ? value : null;
}

function statusFromBlock(block: TimelineBlockView): RuntimeApprovalStatus {
  switch (block.status) {
    case "granted": return "granted";
    case "rejected": return "rejected";
    case "expired": return "expired";
    default: return "requested";
  }
}

export function RuntimeApprovalCard(props: {
  runId: string;
  block: TimelineBlockView;
  effectiveStatus?: RuntimeApprovalStatus;
  busy: boolean;
  onResolve?: (action: RuntimeApprovalAction, approve: boolean) => void;
}) {
  const metadata = props.block.metadata;
  const approvalId = stringMetadata(metadata, "approval_id");
  const stepId = stringMetadata(metadata, "step_id") ?? "run";
  const capabilityId = stringMetadata(metadata, "capability_id");
  const environment = stringMetadata(metadata, "environment");
  const targetResource = stringMetadata(metadata, "target_resource");
  const expiresAt = stringMetadata(metadata, "expires_at");
  const status = props.effectiveStatus ?? statusFromBlock(props.block);
  const action = approvalId
    ? { runId: props.runId, approvalId }
    : null;

  if (status !== "requested") {
    const granted = status === "granted";
    const expired = status === "expired";
    return <section
      className={cn(
        "grid max-w-[780px] gap-2 rounded-lg border p-3.5 shadow-card",
        expired ? "border-warning/40 bg-warning-soft" : granted ? "border-success/40 bg-success-soft" : "border-danger/40 bg-danger-soft",
      )}
      data-runtime-approval={status}
    >
      <p className={cn("flex items-center gap-2 text-xs font-semibold", expired ? "text-warning" : granted ? "text-success" : "text-danger")}>
        {expired ? <Clock3 className="size-3.5" /> : granted ? <Check className="size-3.5" /> : <X className="size-3.5" />}
        {expired ? "审批已过期" : granted ? "Runtime 步骤已批准" : "Runtime 步骤已拒绝"}
      </p>
      <p className="font-mono text-xs text-muted">{capabilityId ?? stepId}</p>
      {expired && <p className="text-xs text-ink-soft">请重新发起 Run，或取消当前等待中的 Run。</p>}
    </section>;
  }

  return <section
    className="grid max-w-[780px] gap-3 rounded-lg border border-warning/50 bg-surface p-3.5 shadow-card"
    data-runtime-approval="requested"
  >
    <div className="flex items-center justify-between gap-3">
      <p className="flex items-center gap-2 text-xs font-semibold text-ink">
        <ShieldAlert className="size-3.5 text-warning" />
        Runtime 步骤需要审批
      </p>
      <span className="font-mono text-xs text-muted">仅本次 Run 有效</span>
    </div>
    <dl className="grid gap-1 font-mono text-xs text-muted">
      <div className="flex gap-2"><dt>步骤</dt><dd className="text-ink-soft">{stepId}</dd></div>
      {capabilityId && <div className="flex gap-2"><dt>能力</dt><dd className="text-ink-soft">{capabilityId}</dd></div>}
      {environment && <div className="flex gap-2"><dt>环境</dt><dd className="text-ink-soft">{environment}</dd></div>}
      {targetResource && <div className="flex gap-2"><dt>目标</dt><dd className="break-all text-ink-soft">{targetResource}</dd></div>}
      {expiresAt && <div className="flex gap-2"><dt>过期</dt><dd className="text-ink-soft">{expiresAt}</dd></div>}
    </dl>
    {!approvalId && <p className="text-xs text-danger">审批记录缺少 approval_id，无法安全操作。</p>}
    <div className="flex gap-2">
      <Button
        className="h-8 text-xs"
        disabled={!action || props.busy || !props.onResolve}
        onClick={() => action && props.onResolve?.(action, true)}
        size="sm"
      >允许一次</Button>
      <Button
        className="h-8 text-xs"
        disabled={!action || props.busy || !props.onResolve}
        onClick={() => action && props.onResolve?.(action, false)}
        size="sm"
        variant="outline"
      >拒绝并停止</Button>
    </div>
  </section>;
}
