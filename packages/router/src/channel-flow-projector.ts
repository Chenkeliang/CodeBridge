import type { ChannelSessionEvent } from "@codebridge/core";

export type ChannelFlowStepStatus =
  | "running"
  | "retrying"
  | "passed"
  | "failed"
  | "skipped";

export interface ChannelFlowStepSnapshot {
  stepId: string;
  capabilityId: string | null;
  status: ChannelFlowStepStatus;
  error: string | null;
  outputRef: string | null;
  verificationStatus: string | null;
}

export interface ChannelFlowArtifactSnapshot {
  artifactId: string;
  stepId: string | null;
  name: string;
  mimeType: string | null;
  resultRef: string | null;
}

export interface ChannelFlowApprovalSnapshot {
  approvalId: string;
  stepId: string;
  capabilityId: string | null;
  status: "requested" | "granted" | "rejected";
  expiresAt: string | null;
}

export interface ChannelFlowVerificationFailure {
  stepId: string;
  category: string;
  postcondition: string | null;
}

export interface ChannelFlowSnapshot {
  flowId: string | null;
  flowRevision: string | null;
  steps: ChannelFlowStepSnapshot[];
  artifacts: ChannelFlowArtifactSnapshot[];
  approvals: ChannelFlowApprovalSnapshot[];
  verificationFailure: ChannelFlowVerificationFailure | null;
  outcome: "succeeded" | "failed" | null;
  batch: ChannelFlowBatchProjection | null;
}

export interface ChannelFlowBatchProjection {
  draftId: string | null;
  batchId: string | null;
  flowId: string | null;
  status: string;
  total: number;
  blocking: number;
  succeeded: number;
  failed: number;
  active: number;
}

export interface ChannelFlowProjector {
  apply(event: ChannelSessionEvent): ChannelFlowSnapshot;
  snapshot(): ChannelFlowSnapshot;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function stepStatusFor(type: string): ChannelFlowStepStatus | null {
  switch (type) {
    case "STEP_STARTED": return "running";
    case "STEP_RETRYING": return "retrying";
    case "STEP_SUCCEEDED": return "passed";
    case "STEP_FAILED": return "failed";
    case "STEP_SKIPPED": return "skipped";
    default: return null;
  }
}

export function createChannelFlowProjector(): ChannelFlowProjector {
  const steps = new Map<string, ChannelFlowStepSnapshot>();
  const artifacts = new Map<string, ChannelFlowArtifactSnapshot>();
  const approvals = new Map<string, ChannelFlowApprovalSnapshot>();
  let flowId: string | null = null;
  let flowRevision: string | null = null;
  let verificationFailure: ChannelFlowVerificationFailure | null = null;
  let outcome: "succeeded" | "failed" | null = null;
  let batch: ChannelFlowBatchProjection | null = null;

  const snapshot = (): ChannelFlowSnapshot => ({
    flowId,
    flowRevision,
    steps: Array.from(steps.values(), (step) => ({ ...step })),
    artifacts: Array.from(artifacts.values(), (artifact) => ({ ...artifact })),
    approvals: Array.from(approvals.values(), (approval) => ({ ...approval })),
    verificationFailure: verificationFailure ? { ...verificationFailure } : null,
    outcome,
    batch: batch ? { ...batch } : null,
  });

  return {
    apply(event) {
      const payload = record(event.payload);
      if (event.type.startsWith("FLOW_BATCH_")) {
        const counts = record(payload.counts);
        batch = {
          draftId: stringValue(payload.draft_id) ?? batch?.draftId ?? null,
          batchId: stringValue(payload.batch_id) ?? batch?.batchId ?? null,
          flowId: stringValue(payload.flow_id) ?? batch?.flowId ?? null,
          status: stringValue(payload.status) ?? batch?.status ?? "queued",
          total: numberValue(payload.total) ?? numberValue(counts.total) ?? batch?.total ?? 0,
          blocking: numberValue(payload.blocking) ?? batch?.blocking ?? 0,
          succeeded: numberValue(counts.succeeded) ?? batch?.succeeded ?? 0,
          failed: numberValue(counts.failed) ?? batch?.failed ?? 0,
          active: [counts.queued, counts.running, counts.waiting]
            .map(numberValue)
            .filter((value): value is number => value !== null)
            .reduce((sum, value) => sum + value, 0),
        };
        return snapshot();
      }
      const status = stepStatusFor(event.type);
      if (status && event.target) {
        const previous = steps.get(event.target);
        steps.set(event.target, {
          stepId: event.target,
          capabilityId: stringValue(payload.capability_id) ?? previous?.capabilityId ?? null,
          status,
          error: stringValue(payload.error) ?? previous?.error ?? null,
          outputRef: previous?.outputRef ?? null,
          verificationStatus: previous?.verificationStatus ?? null,
        });
        return snapshot();
      }

      if (event.type === "ARTIFACT_CREATED") {
        const artifactId = stringValue(payload.artifact_id) ?? event.target;
        if (!artifactId) return snapshot();
        const previous = artifacts.get(artifactId);
        artifacts.set(artifactId, {
          artifactId,
          stepId: stringValue(payload.step_id) ?? previous?.stepId ?? null,
          name: stringValue(payload.name) ?? previous?.name ?? artifactId,
          mimeType: stringValue(payload.mime_type) ?? previous?.mimeType ?? null,
          resultRef: event.resultRef ?? previous?.resultRef ?? null,
        });
        return snapshot();
      }

      if (event.type === "VERIFICATION_FAILED") {
        verificationFailure = {
          stepId: stringValue(payload.step_id) ?? event.target ?? "?",
          category: stringValue(payload.category) ?? "verification",
          postcondition: stringValue(payload.postcondition),
        };
        return snapshot();
      }

      if (
        event.type === "APPROVAL_REQUESTED"
        || event.type === "APPROVAL_GRANTED"
        || event.type === "APPROVAL_REJECTED"
      ) {
        const approvalId = stringValue(payload.approval_id);
        if (!approvalId) return snapshot();
        const previous = approvals.get(approvalId);
        approvals.set(approvalId, {
          approvalId,
          stepId: stringValue(payload.step_id) ?? previous?.stepId ?? "run",
          capabilityId: event.target ?? previous?.capabilityId ?? null,
          status: event.type === "APPROVAL_REQUESTED"
            ? "requested"
            : event.type === "APPROVAL_GRANTED"
              ? "granted"
              : "rejected",
          expiresAt: stringValue(payload.expires_at) ?? previous?.expiresAt ?? null,
        });
        return snapshot();
      }

      if (event.type === "RUN_SNAPSHOT") {
        flowId = stringValue(payload.flow_id) ?? flowId;
        flowRevision = stringValue(payload.flow_revision) ?? flowRevision;
        outcome = payload.outcome === "failed" ? "failed" : "succeeded";
        const trace = Array.isArray(payload.steps) ? payload.steps : [];
        for (const value of trace) {
          const item = record(value);
          const stepId = stringValue(item.step_id);
          if (!stepId) continue;
          const previous = steps.get(stepId);
          steps.set(stepId, {
            stepId,
            capabilityId: stringValue(item.capability_id) ?? previous?.capabilityId ?? null,
            status: previous?.status
              ?? (item.verification_status === "failed" ? "failed" : "passed"),
            error: previous?.error ?? null,
            outputRef: stringValue(item.output_ref) ?? previous?.outputRef ?? null,
            verificationStatus: stringValue(item.verification_status)
              ?? previous?.verificationStatus
              ?? null,
          });
        }
      }
      return snapshot();
    },
    snapshot,
  };
}

function stepIcon(status: ChannelFlowStepStatus): string {
  switch (status) {
    case "passed": return "✓";
    case "failed": return "✗";
    case "skipped": return "○";
    case "retrying": return "↻";
    case "running": return "●";
  }
}

function stepLabel(step: ChannelFlowStepSnapshot): string {
  return step.capabilityId ?? step.stepId;
}

export function renderChannelFlowLive(snapshot: ChannelFlowSnapshot): string {
  const completed = snapshot.steps.filter((step) =>
    step.status === "passed" || step.status === "failed" || step.status === "skipped"
  ).length;
  const recentSteps = snapshot.steps.slice(-4).map((step) => {
    const suffix = step.status === "running"
      ? "（执行中）"
      : step.status === "retrying"
        ? "（重试中）"
        : "";
    return `${stepIcon(step.status)} ${stepLabel(step)}${suffix}`;
  });
  const latestApproval = snapshot.approvals.at(-1);
  const approvalLines = latestApproval?.status === "requested"
    ? [
        "⏸ **Flow 等待步骤审批**",
        `步骤：${latestApproval.stepId}`,
        latestApproval.capabilityId ? `能力：${latestApproval.capabilityId}` : undefined,
        "回复 /flow approve 批准，或 /flow reject 拒绝；也可在 Web Workbench 处理。",
      ]
    : latestApproval?.status === "granted"
      ? ["✅ **Flow 步骤审批已通过，继续执行**"]
      : latestApproval?.status === "rejected"
        ? ["⛔ **Flow 步骤审批已拒绝**"]
        : [];
  return [
    snapshot.batch ? renderBatch(snapshot.batch) : undefined,
    snapshot.steps.length ? `**Flow 进度 · ${completed} / ${snapshot.steps.length}**` : undefined,
    ...recentSteps,
    ...approvalLines,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function renderChannelFlowFinal(snapshot: ChannelFlowSnapshot): string {
  if (!snapshot.outcome && !snapshot.steps.length && !snapshot.artifacts.length && !snapshot.batch) return "";
  const passed = snapshot.steps.filter((step) => step.verificationStatus === "passed").length;
  const stepLines = snapshot.steps.map((step) => {
    const details = [step.error, step.outputRef].filter(Boolean).join(" · ");
    return `${stepIcon(step.status)} ${stepLabel(step)}${details ? ` · ${details}` : ""}`;
  });
  const failureLines = snapshot.verificationFailure
    ? [
        `验证失败：${snapshot.verificationFailure.stepId} · ${snapshot.verificationFailure.category}`,
        snapshot.verificationFailure.postcondition
          ? `验收条件：${snapshot.verificationFailure.postcondition}`
          : undefined,
      ]
    : [];
  const artifactLines = snapshot.artifacts.map((artifact) =>
    `产物：${artifact.name}${artifact.resultRef ? ` · ${artifact.resultRef}` : ""}`
  );
  return [
    snapshot.outcome ? `**Flow 结果 · ${snapshot.outcome === "failed" ? "失败" : "成功"}**` : undefined,
    snapshot.batch ? renderBatch(snapshot.batch) : undefined,
    snapshot.flowId
      ? `${snapshot.flowId}${snapshot.flowRevision ? ` · ${snapshot.flowRevision}` : ""}`
      : undefined,
    snapshot.steps.length ? `${passed} / ${snapshot.steps.length} 步通过验收` : undefined,
    ...stepLines,
    ...failureLines,
    ...artifactLines,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function renderBatch(batch: ChannelFlowBatchProjection): string {
  if (!batch.batchId) {
    return [
      `**Flow 批量草稿 · ${batch.status}**`,
      `可处理 ${batch.total - batch.blocking} · 需补充 ${batch.blocking} · 共 ${batch.total}`,
      batch.draftId ? `查看或确认：/flow batch show ${batch.draftId}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n");
  }
  return [
    `**Flow 批量执行 · ${batch.status}**`,
    `成功 ${batch.succeeded} · 运行 ${batch.active} · 失败 ${batch.failed} · 共 ${batch.total}`,
    `查看：/flow batch show ${batch.batchId}`,
  ].join("\n");
}
