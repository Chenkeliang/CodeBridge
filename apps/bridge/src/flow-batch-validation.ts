import type { FlowInput, FlowRecord } from "@codebridge/flow-catalog";
import type {
  FlowBatchDraftItem,
  FlowBatchInputEvidence,
  FlowBatchInvocationIssue,
  FlowBatchDraftStatus,
} from "@codebridge/work-items";

export type FlowBatchValidationErrorCode =
  | "batch_item_invalid"
  | "batch_limit_exceeded";

export class FlowBatchValidationError extends Error {
  constructor(
    public readonly code: FlowBatchValidationErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "FlowBatchValidationError";
  }
}

export interface ValidatedFlowBatchDraft {
  status: Extract<FlowBatchDraftStatus, "needs_input" | "ready">;
  globalInputs: Record<string, unknown>;
  items: FlowBatchDraftItem[];
  sourceRefs: string[];
}

type Candidate = Record<string, unknown>;

export function validateFlowBatchDraft(
  flow: FlowRecord,
  candidate: unknown,
  limits: { maxItems: number } = { maxItems: 500 },
): ValidatedFlowBatchDraft {
  if (!isRecord(candidate) || !Array.isArray(candidate.items)) {
    throw new FlowBatchValidationError("batch_item_invalid");
  }
  if (candidate.items.length === 0) {
    throw new FlowBatchValidationError("batch_item_invalid", {
      reason: "items_required",
    });
  }
  if (candidate.items.length > limits.maxItems) {
    throw new FlowBatchValidationError("batch_limit_exceeded", {
      maximum: limits.maxItems,
      actual: candidate.items.length,
    });
  }

  const definitions = flow.inputs.filter((input) =>
    input.source === "user" || input.source === "default"
  );
  const definitionById = new Map(definitions.map((input) => [input.id, input]));
  const sourceRefs = stringArray(candidate.source_refs ?? candidate.sourceRefs);
  const globalEvidence = evidenceRecord(
    candidate.global_evidence ?? candidate.globalEvidence,
    definitionById,
  );
  const globalIssues: FlowBatchInvocationIssue[] = [];
  const globalInputs = normalizeRecord(
    recordOrEmpty(candidate.global_inputs ?? candidate.globalInputs),
    definitionById,
    globalEvidence,
    globalIssues,
    { allowSecretWithoutEvidence: false },
  );
  applyDefaults(definitions, globalInputs);

  const usedItemIds = new Set<string>();
  const seenResolved = new Set<string>();
  const items = candidate.items.map((raw, ordinal) => {
    if (!isRecord(raw)) {
      throw new FlowBatchValidationError("batch_item_invalid", { ordinal });
    }
    const requestedId = stringValue(raw.item_id ?? raw.itemId);
    const baseItemId = requestedId || `item_${ordinal + 1}`;
    const itemId = uniqueItemId(baseItemId, usedItemIds);
    const evidence = {
      ...globalEvidence,
      ...evidenceRecord(raw.evidence, definitionById),
    };
    const issues = [
      ...cloneIssues(globalIssues),
      ...candidateIssues(raw.issues),
    ];
    if (itemId !== baseItemId) {
      issues.push(issue(
        "conflict",
        null,
        `重复 item_id：${baseItemId}`,
      ));
    }
    const inputs = normalizeRecord(
      recordOrEmpty(raw.inputs),
      definitionById,
      evidence,
      issues,
      { allowSecretWithoutEvidence: false },
    );
    const resolved = { ...globalInputs, ...inputs };
    for (const definition of definitions) {
      const value = resolved[definition.id];
      if (
        definition.required
        && (value === undefined || value === null || value === "")
      ) {
        issues.push(issue(
          "missing",
          definition.id,
          `缺少必填参数：${definition.id}`,
        ));
      }
      if (value !== undefined && definition.type !== "secret_ref") {
        const proof = evidence[definition.id];
        if (!proof && definition.default === undefined) {
          issues.push(issue(
            "invalid_value",
            definition.id,
            `参数 ${definition.id} 缺少来源证据`,
          ));
        }
      }
    }
    const duplicateKey = stableStringify(resolved);
    if (seenResolved.has(duplicateKey)) {
      issues.push(issue("duplicate", null, "该组参数与前一项重复"));
    } else {
      seenResolved.add(duplicateKey);
    }
    return {
      itemId,
      ordinal,
      label: stringValue(raw.label) || null,
      inputs,
      evidence,
      issues: deduplicateIssues(issues),
    } satisfies FlowBatchDraftItem;
  });

  const status = items.some((item) =>
    item.issues.some((entry) => entry.blocking)
  ) ? "needs_input" : "ready";
  return { status, globalInputs, items, sourceRefs };
}

function normalizeRecord(
  values: Record<string, unknown>,
  definitions: Map<string, FlowInput>,
  evidence: Record<string, FlowBatchInputEvidence>,
  issues: FlowBatchInvocationIssue[],
  options: { allowSecretWithoutEvidence: boolean },
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(values)) {
    const definition = definitions.get(id);
    if (!definition) continue;
    const result = normalizeValue(definition, raw, evidence[id], options);
    if (result.issue) {
      issues.push(result.issue);
      continue;
    }
    if (result.value !== undefined) normalized[id] = result.value;
  }
  return normalized;
}

function normalizeValue(
  definition: FlowInput,
  raw: unknown,
  evidence: FlowBatchInputEvidence | undefined,
  options: { allowSecretWithoutEvidence: boolean },
): { value?: unknown; issue?: FlowBatchInvocationIssue } {
  if (definition.type === "integer") {
    const number = typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^-?\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN;
    return Number.isSafeInteger(number)
      ? { value: number }
      : { issue: issue("invalid_type", definition.id, `${definition.id} 必须是整数`) };
  }
  if (typeof raw !== "string") {
    return {
      issue: issue("invalid_type", definition.id, `${definition.id} 必须是字符串`),
    };
  }
  const value = raw.trim();
  if (definition.type === "enum" && !definition.values?.includes(value)) {
    return {
      issue: issue("invalid_value", definition.id, `${definition.id} 不在允许值中`),
    };
  }
  if (definition.type === "secret_ref") {
    if (
      !value
      || (!options.allowSecretWithoutEvidence && !evidence)
      || evidence?.source === "agent_extracted"
      || evidence?.inferred === true
    ) {
      return {
        issue: issue(
          "invalid_value",
          definition.id,
          `${definition.id} 必须由用户提供 secret 引用，不能由 Agent 推断`,
        ),
      };
    }
    return { value };
  }
  if (definition.pattern) {
    let matches = false;
    try {
      matches = new RegExp(definition.pattern).test(value);
    } catch {
      matches = false;
    }
    if (!matches) {
      return {
        issue: issue("invalid_value", definition.id, `${definition.id} 格式不正确`),
      };
    }
  }
  return { value };
}

function applyDefaults(
  definitions: FlowInput[],
  globalInputs: Record<string, unknown>,
): void {
  for (const definition of definitions) {
    if (globalInputs[definition.id] !== undefined || definition.default === undefined) {
      continue;
    }
    const normalized = normalizeValue(
      definition,
      definition.default,
      { source: "default", evidenceRef: `flow.default:${definition.id}`, inferred: false },
      { allowSecretWithoutEvidence: false },
    );
    if (!normalized.issue && normalized.value !== undefined) {
      globalInputs[definition.id] = normalized.value;
    }
  }
}

function evidenceRecord(
  value: unknown,
  definitions: Map<string, FlowInput>,
): Record<string, FlowBatchInputEvidence> {
  if (!isRecord(value)) return {};
  const result: Record<string, FlowBatchInputEvidence> = {};
  for (const [field, raw] of Object.entries(value)) {
    if (!definitions.has(field) || !isRecord(raw)) continue;
    const source = raw.source;
    const evidenceRef = stringValue(raw.evidence_ref ?? raw.evidenceRef);
    if (
      !["user", "agent_extracted", "context", "default"].includes(String(source))
      || !evidenceRef
    ) {
      continue;
    }
    result[field] = {
      source: source as FlowBatchInputEvidence["source"],
      evidenceRef,
      inferred: raw.inferred === true,
    };
  }
  return result;
}

function candidateIssues(value: unknown): FlowBatchInvocationIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const code = raw.code;
    if (code !== "ambiguous" && code !== "conflict") return [];
    const message = stringValue(raw.message);
    if (!message) return [];
    return [issue(
      code,
      stringValue(raw.field) || null,
      message,
      raw.blocking !== false,
    )];
  });
}

function issue(
  code: FlowBatchInvocationIssue["code"],
  field: string | null,
  message: string,
  blocking = true,
): FlowBatchInvocationIssue {
  return { code, field, message, blocking };
}

function deduplicateIssues(
  issues: FlowBatchInvocationIssue[],
): FlowBatchInvocationIssue[] {
  const seen = new Set<string>();
  return issues.filter((entry) => {
    const key = `${entry.code}:${entry.field ?? ""}:${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cloneIssues(
  issues: FlowBatchInvocationIssue[],
): FlowBatchInvocationIssue[] {
  return issues.map((entry) => ({ ...entry }));
}

function uniqueItemId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  const value = `${base}_${suffix}`;
  used.add(value);
  return value;
}

function stableStringify(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Candidate {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
