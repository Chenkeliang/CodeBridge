import { createHash, randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";

export type WorkflowKind = "guide" | "runbook";
export type WorkflowStatus = "draft" | "published" | "deprecated";
export type WorkflowStepMode =
  | "read_only"
  | "workspace_write"
  | "git_write"
  | "production_write"
  | "manual";

export interface WorkflowBranch {
  when: string;
  next: string;
}

export interface WorkflowRetryPolicy {
  maxAttempts: number;
  delayMs: number;
}

export type WorkflowInputType = "string" | "integer" | "enum" | "directory" | "secret_ref";

export type WorkflowInputSource =
  | "user"
  | "context"
  | "agent"
  | "step_output"
  | "default";

export interface WorkflowInput {
  id: string;
  type: WorkflowInputType;
  required?: boolean;
  /** Regex for type=string. */
  pattern?: string;
  /** Config- or run-time origin. `context` covers `context.*` paths via `from`. */
  source: WorkflowInputSource;
  /** Allowed values for type=enum. */
  values?: string[];
  /** Static default (config-time). */
  default?: string;
  /** Value guard: e.g. `when: "value == 'production'"` forbids agent prefill. */
  confirmation?: { when: string };
  /** Reference path for source=step_output / context: `steps.<id>.outputs.<key>` or `context.<name>`. */
  from?: string;
  /** directory inputs must resolve within authorized folders. */
  scope?: "authorized_folders";
}

export interface WorkflowStep {
  id: string;
  capability?: string;
  mode?: WorkflowStepMode;
  approval?: "none" | "required";
  purpose?: string;
  dependsOn: string[];
  branches: WorkflowBranch[];
  retry?: WorkflowRetryPolicy;
}

export interface WorkflowDefinition {
  schemaVersion: 1;
  workflowId: string;
  name: string;
  kind: WorkflowKind;
  status: WorkflowStatus;
  description?: string;
  inputs: WorkflowInput[];
  steps: WorkflowStep[];
}

export interface PlanStep {
  id: string;
  capabilityId: string | null;
  risk: WorkflowStepMode;
  dependsOn: string[];
  guard: string | null;
  approval: "none" | "required";
  branches: WorkflowBranch[];
  purpose: string | null;
  retry: WorkflowRetryPolicy | null;
}

export interface PlanIR {
  planId: string;
  source: "workflow" | "agent_generated";
  workflowId: string;
  definitionRevision: string | null;
  inputs: WorkflowInput[];
  steps: PlanStep[];
}

export interface CompileWorkflowOptions {
  definitionRevision?: string | null;
  source?: "workflow" | "agent_generated";
}

export class WorkflowValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join("; "));
    this.name = "WorkflowValidationError";
  }
}

export function parseWorkflow(source: string): WorkflowDefinition {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    throw new WorkflowValidationError([
      `workflow YAML parse failed: ${messageOf(error)}`,
    ]);
  }
  return normalizeDefinition(parsed);
}

export function compileWorkflow(
  input: unknown,
  options: CompileWorkflowOptions = {},
): PlanIR {
  const definition = normalizeDefinition(input);
  const issues = validateDefinition(definition);
  if (issues.length) throw new WorkflowValidationError(issues);

  return {
    planId: `plan_${randomUUID().replaceAll("-", "")}`,
    source: options.source ?? "workflow",
    workflowId: definition.workflowId,
    definitionRevision: options.definitionRevision ?? null,
    inputs: definition.inputs.map((input) => ({ ...input })),
    steps: definition.steps.map((step) => ({
      id: step.id,
      capabilityId: step.capability ?? null,
      risk: step.mode ?? (step.branches.length ? "read_only" : "manual"),
      dependsOn: [...step.dependsOn],
      guard: step.branches.length ? null : null,
      approval: step.approval ?? "none",
      branches: step.branches.map((branch) => ({ ...branch })),
      purpose: step.purpose ?? null,
      retry: step.retry ? { ...step.retry } : null,
    })),
  };
}

function normalizeDefinition(input: unknown): WorkflowDefinition {
  const issues: string[] = [];
  if (!isRecord(input)) {
    throw new WorkflowValidationError(["workflow must be an object"]);
  }

  // `parseWorkflow` returns the canonical in-memory shape. Accepting that
  // shape here keeps `compileWorkflow(parseWorkflow(source))` lossless while
  // still allowing callers to compile a raw YAML/JSON object directly.
  if (input.schemaVersion === 1 || input.workflowId !== undefined) {
    return normalizeCanonicalDefinition(input, issues);
  }

  if (input.schema_version !== 1) issues.push("schema_version must be 1");
  const workflowId = stringField(input.workflow_id, "workflow_id", issues);
  const name = stringField(input.name, "name", issues);
  const kind = enumField(input.kind, ["guide", "runbook"], "kind", issues);
  const status = enumField(
    input.status,
    ["draft", "published", "deprecated"],
    "status",
    issues,
  );
  const description =
    input.description === undefined
      ? undefined
      : stringField(input.description, "description", issues);
  const inputs = normalizeInputs(input.inputs ?? [], issues);

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    issues.push("steps must contain at least one step");
  }
  const steps = Array.isArray(input.steps)
    ? input.steps.map((value, index) => normalizeStep(value, index, issues))
    : [];

  if (issues.length) throw new WorkflowValidationError(issues);
  return {
    schemaVersion: 1,
    workflowId: workflowId!,
    name: name!,
    kind: kind as WorkflowKind,
    status: status as WorkflowStatus,
    description,
    inputs,
    steps,
  };
}

function normalizeCanonicalDefinition(
  input: Record<string, unknown>,
  issues: string[],
): WorkflowDefinition {
  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== 1) issues.push("schemaVersion must be 1");
  const workflowId = stringField(input.workflowId, "workflowId", issues);
  const name = stringField(input.name, "name", issues);
  const kind = enumField(input.kind, ["guide", "runbook"], "kind", issues);
  const status = enumField(
    input.status,
    ["draft", "published", "deprecated"],
    "status",
    issues,
  );
  const description =
    input.description === undefined
      ? undefined
      : stringField(input.description, "description", issues);
  const inputs = normalizeInputs(input.inputs ?? [], issues);

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    issues.push("steps must contain at least one step");
  }
  const steps = Array.isArray(input.steps)
    ? input.steps.map((value, index) => normalizeCanonicalStep(value, index, issues))
    : [];

  if (issues.length) throw new WorkflowValidationError(issues);
  return {
    schemaVersion: 1,
    workflowId: workflowId!,
    name: name!,
    kind: kind as WorkflowKind,
    status: status as WorkflowStatus,
    description,
    inputs,
    steps,
  };
}

function normalizeCanonicalStep(
  input: unknown,
  index: number,
  issues: string[],
): WorkflowStep {
  const prefix = `step[${index}]`;
  if (!isRecord(input)) {
    issues.push(`${prefix} must be an object`);
    return { id: `invalid_${index}`, dependsOn: [], branches: [] };
  }
  const id = stringField(input.id, `${prefix}.id`, issues) ?? `invalid_${index}`;
  const capability =
    input.capability === undefined
      ? undefined
      : stringField(input.capability, `${prefix}.capability`, issues);
  const mode =
    input.mode === undefined
      ? undefined
      : enumField(
          input.mode,
          [
            "read_only",
            "workspace_write",
            "git_write",
            "production_write",
            "manual",
          ],
          `${prefix}.mode`,
          issues,
        );
  const approval =
    input.approval === undefined
      ? undefined
      : enumField(input.approval, ["none", "required"], `${prefix}.approval`, issues);
  const purpose =
    input.purpose === undefined
      ? undefined
      : stringField(input.purpose, `${prefix}.purpose`, issues);
  const dependsOn = stringArrayField(
    input.dependsOn ?? [],
    `${prefix}.dependsOn`,
    issues,
  );
  const branches = normalizeBranches(input.branches, prefix, issues);
  const retry = normalizeRetry(input.retry, prefix, issues, true);
  return {
    id,
    capability,
    mode: mode as WorkflowStepMode | undefined,
    approval: approval as "none" | "required" | undefined,
    purpose,
    dependsOn,
    branches,
    retry,
  };
}

function normalizeStep(
  input: unknown,
  index: number,
  issues: string[],
): WorkflowStep {
  const prefix = `step[${index}]`;
  if (!isRecord(input)) {
    issues.push(`${prefix} must be an object`);
    return {
      id: `invalid_${index}`,
      dependsOn: [],
      branches: [],
    };
  }

  const id = stringField(input.id, `${prefix}.id`, issues) ?? `invalid_${index}`;
  const capability =
    input.capability === undefined
      ? undefined
      : stringField(input.capability, `${prefix}.capability`, issues);
  const mode =
    input.mode === undefined
      ? undefined
      : enumField(
          input.mode,
          [
            "read_only",
            "workspace_write",
            "git_write",
            "production_write",
            "manual",
          ],
          `${prefix}.mode`,
          issues,
        );
  const approval =
    input.approval === undefined
      ? undefined
      : enumField(input.approval, ["none", "required"], `${prefix}.approval`, issues);
  const purpose =
    input.purpose === undefined
      ? undefined
      : stringField(input.purpose, `${prefix}.purpose`, issues);
  const dependsOn = stringArrayField(
    input.depends_on ?? [],
    `${prefix}.depends_on`,
    issues,
  );
  const branches = normalizeBranches(input.branches, prefix, issues);
  const retry = normalizeRetry(input.retry, prefix, issues, false);

  return {
    id,
    capability,
    mode: mode as WorkflowStepMode | undefined,
    approval: approval as "none" | "required" | undefined,
    purpose,
    dependsOn,
    branches,
    retry,
  };
}

function normalizeRetry(
  input: unknown,
  prefix: string,
  issues: string[],
  canonical: boolean,
): WorkflowRetryPolicy | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) {
    issues.push(`${prefix}.retry must be an object`);
    return undefined;
  }
  const maxAttemptsValue = input[canonical ? "maxAttempts" : "max_attempts"];
  if (!Number.isInteger(maxAttemptsValue) || Number(maxAttemptsValue) < 1 || Number(maxAttemptsValue) > 10) {
    issues.push(`${prefix}.retry.${canonical ? "maxAttempts" : "max_attempts"} must be an integer between 1 and 10`);
  }
  const delayField = canonical ? "delayMs" : "delay_ms";
  const delayValue = input[delayField] ?? 0;
  if (!Number.isInteger(delayValue) || Number(delayValue) < 0 || Number(delayValue) > 300_000) {
    issues.push(`${prefix}.retry.${delayField} must be an integer between 0 and 300000`);
  }
  if (!Number.isInteger(maxAttemptsValue) || !Number.isInteger(delayValue)) return undefined;
  return { maxAttempts: Number(maxAttemptsValue), delayMs: Number(delayValue) };
}

function normalizeBranches(
  input: unknown,
  prefix: string,
  issues: string[],
): WorkflowBranch[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    issues.push(`${prefix}.branches must be an array`);
    return [];
  }
  return input.map((value, index) => {
    if (!isRecord(value)) {
      issues.push(`${prefix}.branches[${index}] must be an object`);
      return { when: "invalid", next: "invalid" };
    }
    return {
      when:
        stringField(value.when, `${prefix}.branches[${index}].when`, issues) ??
        "invalid",
      next:
        stringField(value.next, `${prefix}.branches[${index}].next`, issues) ??
        "invalid",
    };
  });
}

const INPUT_TYPES: readonly WorkflowInputType[] = ["string", "integer", "enum", "directory", "secret_ref"];
const INPUT_SOURCES: readonly WorkflowInputSource[] = ["user", "context", "agent", "step_output", "default"];

function normalizeInputs(value: unknown, issues: string[]): WorkflowInput[] {
  if (!Array.isArray(value)) {
    issues.push("inputs must be an array");
    return [];
  }
  return value.map((item, index) => normalizeInput(item, index, issues));
}

function normalizeInput(item: unknown, index: number, issues: string[]): WorkflowInput {
  const prefix = `inputs[${index}]`;
  // Legacy shorthand: a bare string is a user-supplied string input.
  if (typeof item === "string") {
    if (!item.trim()) issues.push(`${prefix} must be a non-empty string`);
    return { id: item, type: "string", source: "user" };
  }
  if (!isRecord(item)) {
    issues.push(`${prefix} must be an object or a string`);
    return { id: `invalid_${index}`, type: "string", source: "user" };
  }
  const id = stringField(item.id, `${prefix}.id`, issues) ?? `invalid_${index}`;
  const type = enumField(item.type ?? "string", INPUT_TYPES, `${prefix}.type`, issues) ?? "string";
  const source = enumField(item.source ?? "user", INPUT_SOURCES, `${prefix}.source`, issues) ?? "user";
  const input: WorkflowInput = { id, type, source };
  if (item.required !== undefined) {
    if (typeof item.required !== "boolean") issues.push(`${prefix}.required must be a boolean`);
    else input.required = item.required;
  }
  if (item.pattern !== undefined) {
    const pattern = stringField(item.pattern, `${prefix}.pattern`, issues);
    if (pattern !== undefined) {
      try { new RegExp(pattern); input.pattern = pattern; }
      catch { issues.push(`${prefix}.pattern is not a valid regex: ${pattern}`); }
    }
  }
  if (type === "enum") {
    if (!Array.isArray(item.values) || !item.values.length || !item.values.every((v) => typeof v === "string" && v)) {
      issues.push(`${prefix}.values must be a non-empty string array for enum inputs`);
    } else {
      input.values = [...item.values];
    }
  }
  if (item.default !== undefined) {
    const def = stringField(item.default, `${prefix}.default`, issues);
    if (def !== undefined) input.default = def;
  }
  if (item.confirmation !== undefined) {
    if (!isRecord(item.confirmation) || typeof item.confirmation.when !== "string" || !item.confirmation.when.trim()) {
      issues.push(`${prefix}.confirmation.when must be a non-empty string`);
    } else {
      input.confirmation = { when: item.confirmation.when };
    }
  }
  if (source === "step_output" || source === "context") {
    const from = item.from === undefined ? undefined : stringField(item.from, `${prefix}.from`, issues);
    if (source === "step_output" && !from) issues.push(`${prefix}.from is required for step_output inputs`);
    if (from) input.from = from;
  }
  if (item.scope !== undefined) {
    if (item.scope !== "authorized_folders") issues.push(`${prefix}.scope must be "authorized_folders"`);
    else input.scope = "authorized_folders";
  }
  return input;
}

function validateDefinition(definition: WorkflowDefinition): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const step of definition.steps) {
    if (ids.has(step.id)) issues.push(`duplicate step id: ${step.id}`);
    ids.add(step.id);
  }

  for (const step of definition.steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        issues.push(`step ${step.id}: dependency does not exist: ${dependency}`);
      }
    }
    for (const branch of step.branches) {
      if (!ids.has(branch.next)) {
        issues.push(`step ${step.id}: branch target does not exist: ${branch.next}`);
      }
    }
    if (step.capability && step.branches.length) {
      issues.push(`step ${step.id}: capability and branches cannot both be set`);
    }
    if (!step.capability && !step.branches.length && step.mode !== "manual") {
      issues.push(`step ${step.id}: capability, branches, or mode manual is required`);
    }
    if (step.mode === "manual" && !step.purpose) {
      issues.push(`step ${step.id}: manual step requires purpose`);
    }
    if (step.mode === "production_write" && step.approval !== "required") {
      issues.push(`step ${step.id}: production_write requires approval: required`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(definition.steps.map((step) => [step.id, step]));
  const visit = (id: string) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const step = byId.get(id);
    const cycle = step?.dependsOn.some(visit) ?? false;
    visiting.delete(id);
    visited.add(id);
    return cycle;
  };
  if ([...byId.keys()].some(visit)) {
    issues.push("workflow contains a dependency cycle");
  }
  return issues;
}

function stringField(
  value: unknown,
  name: string,
  issues: string[],
): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  issues.push(`${name} must be a non-empty string`);
  return undefined;
}

function stringArrayField(
  value: unknown,
  name: string,
  issues: string[],
): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...value];
  }
  issues.push(`${name} must be an array of strings`);
  return [];
}

function enumField<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
  issues: string[],
): T | undefined {
  if (typeof value === "string" && values.includes(value as T)) {
    return value as T;
  }
  issues.push(`${name} must be one of: ${values.join(", ")}`);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * RFC 8785-style (JCS) canonical JSON: keys sorted recursively, no
 * insignificant whitespace, UTF-8. Deterministic across key insertion order.
 * Scope note: number serialization uses JSON.stringify semantics (adequate
 * for flow definitions/schemas); strict RFC 8785 number/I-JSON edge cases
 * are intentionally out of scope for this contract content.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported value type ${typeof value}`);
}

/** sha256 of RFC 8785-style canonical JSON — for structured content (schemas, flow definitions, PlanIR). */
export function definitionHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

/** sha256 of raw bytes — for prompt templates where whitespace is semantically meaningful. */
export function promptHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
