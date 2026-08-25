import type { AgentSession } from "@codebridge/session-catalog";
import type { DomainEvent, Run } from "@codebridge/work-items";
import { definitionHash } from "@codebridge/workflow-engine";

const MAX_EXTRACTED_STEPS = 24;
const MAX_EXTRACTED_PURPOSE_CHARACTERS = 240;
const MAX_SOURCE_TEXT_CHARACTERS = 4_096;
const FLOW_SAVE_TOOL_MARKER = "flow_save_request/v1";

export interface ExtractRunDefinitionInput {
  session: Pick<AgentSession, "id" | "agentId">;
  run: Run;
  title: string;
  events: DomainEvent[];
}

export type ExtractRunDefinitionResult =
  | {
      ok: true;
      kind: "structured_plan" | "observed_trace";
      name: string;
      description: string | null;
      steps: Array<{ id: string; purpose: string; dependsOn: string[] }>;
      sourceFlowId: string;
      sourceDefinitionRevision: string;
      sourceImported: boolean;
      warnings: string[];
      provenance: {
        sourceRunId: string;
        sourceSessionId: string;
        sourceFlowId: string;
        sourceDefinitionRevision: string;
      };
    }
  | {
      ok: false;
      code: "run_not_succeeded" | "run_not_extractable";
      reason: string;
    };

interface ExtractedDefinition {
  kind: "structured_plan" | "observed_trace";
  name: string;
  description: string | null;
  steps: Array<{ id: string; purpose: string; dependsOn: string[] }>;
  sourceFlowId: string;
  sourceDefinitionRevision: string;
  warnings: string[];
}

export function extractRunDefinition(
  input: ExtractRunDefinitionInput,
): ExtractRunDefinitionResult {
  if (input.run.status !== "succeeded") {
    return {
      ok: false,
      code: "run_not_succeeded",
      reason: "Run 未成功，不能提取 Flow 定义",
    };
  }
  if (
    input.run.executionKind !== "agent"
    || input.run.sessionId !== input.session.id
  ) {
    return {
      ok: false,
      code: "run_not_extractable",
      reason: "只有当前 Session 的 Agent Run 可以提取 Flow 定义",
    };
  }

  const scopedInput = {
    ...input,
    events: input.events.filter((event) =>
      event.runId === input.run.id
      && event.workItemId === input.run.workItemId
    ),
  };
  const definition = extractStructuredPlan(scopedInput) ?? extractObservedTrace(scopedInput);
  if (!definition) {
    return {
      ok: false,
      code: "run_not_extractable",
      reason: "Run 没有结构化 Agent 计划，也没有足够的业务工具调用证据",
    };
  }

  return {
    ok: true,
    ...definition,
    sourceImported: scopedInput.events.some((event) => event.payload.imported === true),
    provenance: {
      sourceRunId: input.run.id,
      sourceSessionId: input.session.id,
      sourceFlowId: definition.sourceFlowId,
      sourceDefinitionRevision: definition.sourceDefinitionRevision,
    },
  };
}

function extractStructuredPlan(
  input: ExtractRunDefinitionInput,
): ExtractedDefinition | null {
  for (const event of [...input.events].reverse()) {
    if (event.type !== "FLOW_PROPOSED") continue;
    const rawFlow = event.payload.flow;
    if (!rawFlow || typeof rawFlow !== "object" || Array.isArray(rawFlow)) continue;
    const flow = rawFlow as Record<string, unknown>;
    const rawSteps = Array.isArray(flow.steps) ? flow.steps : [];
    let purposeTruncated = false;
    const validSteps = rawSteps.slice(0, MAX_EXTRACTED_STEPS).flatMap((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const step = raw as Record<string, unknown>;
      const rawPurpose = typeof step.purpose === "string" ? step.purpose : "";
      const boundedPurpose = boundPurpose(rawPurpose);
      if (boundedPurpose.truncated) purposeTruncated = true;
      const purpose = boundedPurpose.value;
      if (!purpose) return [];
      return [{
        rawId: typeof step.id === "string" && step.id.trim()
          ? step.id.trim()
          : `step_${index + 1}`,
        rawDependsOn: Array.isArray(step.depends_on)
          ? step.depends_on.filter((value): value is string => typeof value === "string")
          : null,
        purpose,
      }];
    });
    if (validSteps.length === 0) continue;

    const canonicalIds = new Map<string, string>();
    validSteps.forEach((step, index) => {
      if (!canonicalIds.has(step.rawId)) canonicalIds.set(step.rawId, `step_${index + 1}`);
    });
    const steps = validSteps.map(({ rawDependsOn, purpose }, index) => ({
      id: `step_${index + 1}`,
      purpose,
      dependsOn: rawDependsOn === null
        ? index ? [`step_${index}`] : []
        : rawDependsOn.flatMap((dependency) => canonicalIds.get(dependency) ?? []),
    }));
    const sourceFlowId = typeof flow.workflow_id === "string" && flow.workflow_id.trim()
      ? flow.workflow_id.trim()
      : `flow_ephemeral_${input.run.id}`;
    const sourceDefinitionRevision = typeof event.payload.definition_revision === "string"
      && event.payload.definition_revision.trim()
      ? event.payload.definition_revision.trim()
      : `agent:${definitionHash({ runId: input.run.id, steps })}`;

    return {
      kind: "structured_plan",
      name: sanitizeDefinitionName(
        typeof flow.name === "string" && flow.name.trim() ? flow.name : input.title,
        `${input.run.agentId ?? input.session.agentId} Run Flow`,
      ),
      description: `基于 ${input.run.agentId ?? input.session.agentId} 成功 Run 的结构化 Agent 计划提取。`,
      steps,
      sourceFlowId,
      sourceDefinitionRevision,
      warnings: [
        ...(rawSteps.length > MAX_EXTRACTED_STEPS
          ? [`结构化计划超过 ${MAX_EXTRACTED_STEPS} 个步骤，已截断`]
          : []),
        ...(purposeTruncated
          ? [`部分步骤说明超过 ${MAX_EXTRACTED_PURPOSE_CHARACTERS} 个字符，已截断`]
          : []),
      ],
    };
  }
  return null;
}

function extractObservedTrace(
  input: ExtractRunDefinitionInput,
): ExtractedDefinition | null {
  const managementToolCallIds = new Set(input.events.flatMap((event) => {
    const agentEvent = agentEventValue(event);
    if (
      agentEvent?.type !== "tool_end"
      || typeof agentEvent.toolCallId !== "string"
      || !(
        isFlowSaveToolResult(agentEvent.output)
        || isFlowSaveToolResult(agentEvent.content)
      )
    ) return [];
    return [agentEvent.toolCallId];
  }));
  const toolNames = input.events.flatMap((event) => {
    const agentEvent = agentEventValue(event);
    if (agentEvent?.type !== "tool_start" || typeof agentEvent.name !== "string") return [];
    if (
      agentEvent.name === "codebridge.request_flow_save"
      || (
        typeof agentEvent.toolCallId === "string"
        && managementToolCallIds.has(agentEvent.toolCallId)
      )
    ) return [];
    return [agentEvent.name];
  });
  if (toolNames.length < 2) return null;

  const boundedPurposes = toolNames.map((name) => boundPurpose(sanitizeToolPurpose(name)));
  const purposeTruncated = boundedPurposes.some((purpose) => purpose.truncated);
  const purposes = boundedPurposes
    .map((purpose) => purpose.value)
    .filter((purpose, index, values) => index === 0 || purpose !== values[index - 1])
    .slice(0, 12);
  if (purposes.length < 2) return null;

  const steps = purposes.map((purpose, index) => ({
    id: `step_${index + 1}`,
    purpose,
    dependsOn: index ? [`step_${index}`] : [],
  }));
  return {
    kind: "observed_trace",
    name: sanitizeDefinitionName(
      input.title,
      `${input.run.agentId ?? input.session.agentId} Run Flow`,
    ),
    description: `基于 ${input.run.agentId ?? input.session.agentId} 成功 Run 的已执行工具轨迹提取；参数已移除。`,
    steps,
    sourceFlowId: `flow_ephemeral_${input.run.id}`,
    sourceDefinitionRevision: `trace:${definitionHash({ runId: input.run.id, purposes })}`,
    warnings: [
      "基于实际工具轨迹生成，未映射 Capability，需人工整理",
      ...(purposeTruncated
        ? [`部分步骤说明超过 ${MAX_EXTRACTED_PURPOSE_CHARACTERS} 个字符，已截断`]
        : []),
    ],
  };
}

function agentEventValue(event: DomainEvent): Record<string, unknown> | null {
  if (event.type !== "AGENT_EVENT") return null;
  const value = event.payload.event;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isFlowSaveToolResult(output: unknown): boolean {
  if (typeof output === "string") {
    const text = output.trim();
    if (text === FLOW_SAVE_TOOL_MARKER) return true;
    if (!text || text.length > MAX_SOURCE_TEXT_CHARACTERS) return false;
    try {
      return isFlowSaveToolResult(JSON.parse(text));
    } catch {
      return false;
    }
  }
  if (Array.isArray(output)) return output.some(isFlowSaveToolResult);
  if (!output || typeof output !== "object") return false;
  const value = output as Record<string, unknown>;
  if (value.codebridge_internal_tool === FLOW_SAVE_TOOL_MARKER) return true;
  if (value.type === "text" && typeof value.text === "string") {
    return isFlowSaveToolResult(value.text);
  }
  return Object.hasOwn(value, "content") && isFlowSaveToolResult(value.content);
}

function sanitizeToolPurpose(name: string): string {
  const boundedName = truncateText(name, MAX_SOURCE_TEXT_CHARACTERS).value;
  const skillScript = boundedName.match(/\/skills\/([^/\s]+)\/scripts\/([^/\s`]+)/i);
  if (skillScript) {
    const script = skillScript[2]!.replace(/\.(?:py|js|ts|sh)$/i, "");
    const skillName = sanitizeReusableText(skillScript[1]!);
    const scriptName = sanitizeReusableText(script);
    if (skillName === skillScript[1] && scriptName === script) {
      return `使用 ${skillName} · ${scriptName}`;
    }
    return "执行受控工具步骤";
  }
  const plain = boundedName.trim();
  if (plain === "Read File") return "使用 Read File";
  if (
    /^[\p{L}\p{N}_.:-]{1,48}$/u.test(plain)
    && sanitizeReusableText(plain) === plain
  ) return `使用 ${plain}`;
  return "执行受控工具步骤";
}

function sanitizeDefinitionName(value: string, fallback: string): string {
  const source = truncateText(value, MAX_SOURCE_TEXT_CHARACTERS).value;
  const firstLine = source.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? fallback;
  const sanitized = sanitizeReusableText(firstLine).replace(/\s+/g, " ").trim() || fallback;
  const characters = Array.from(sanitized);
  return characters.length > 60 ? `${characters.slice(0, 60).join("")}…` : characters.join("");
}

function truncateText(value: string, maxCharacters: number): { value: string; truncated: boolean } {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return { value, truncated: false };
  return {
    value: `${characters.slice(0, Math.max(0, maxCharacters - 1)).join("")}…`,
    truncated: true,
  };
}

function boundPurpose(value: string): { value: string; truncated: boolean } {
  const boundedSource = truncateText(value, MAX_SOURCE_TEXT_CHARACTERS);
  const boundedPurpose = truncateText(
    sanitizeReusableText(boundedSource.value),
    MAX_EXTRACTED_PURPOSE_CHARACTERS,
  );
  return {
    value: boundedPurpose.value,
    truncated: boundedSource.truncated || boundedPurpose.truncated,
  };
}

function sanitizeReusableText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, "链接")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "参数")
    .replace(/(?:~\/|\/Users\/|\/home\/|[A-Za-z]:\\)[^\s]+/g, "本地路径")
    .replace(/(^|\s)-{1,2}[\p{L}\p{N}_.-]+(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gu, "$1参数")
    .replace(/\b(?=[A-Za-z0-9_-]{6,}\b)(?=[A-Za-z0-9_-]*\d{6,})[A-Za-z0-9_-]+\b/g, "参数")
    .replace(/\s+/g, " ")
    .trim();
}
