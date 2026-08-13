# Flow Phase 0 Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the phase-0 Flow contracts from `docs/superpowers/specs/2026-08-13-flow-design.md`: typed inputs, learning-signal event types, canonical hashing, and the attribution block — pure schema/type work, no engine changes.

**Architecture:** `workflow-engine` gains typed-input normalization/validation and `definitionHash()` (RFC 8785 JCS + sha256); `flow-catalog` persists `inputs` and `plan_ir_hash`; `work-items` accepts the four learning-signal event types; `policy` manifest gains `capabilityVersion`. Bridge compiles with a deterministic hash and stores the compile tuple.

**Tech Stack:** TypeScript, node:sqlite (via createRequire), node:crypto sha256, Vitest, pnpm. No JSON-Schema runtime validator is introduced — types + runtime normalizers follow the existing `workflow-engine` pattern.

---

## File map

- `packages/workflow-engine/src/index.ts`: typed inputs (`WorkflowInput`, source enum, confirmation, from), `definitionHash()`, PlanIR gains `inputs`; validation for typed inputs (type/source/required/pattern/enum/default/confirmation/from).
- `packages/workflow-engine/src/index.test.ts`: typed-input parse/validate/hash tests.
- `packages/work-items/src/index.ts`: `DomainEventType` gains `PARAM_RESOLVED`, `FLOW_RECOMMENDED`, `FLOW_REJECTED`, `RUN_SNAPSHOT`; typed payload interfaces `ParamResolvedPayload`, `FlowRecommendedPayload`, `FlowRejectedPayload`, `VerificationFailedPayload`, `RunSnapshotPayload`, `Attribution`, `ResolvedInput`, `DecisionTraceStep`.
- `packages/work-items/src/events.test.ts` (create): payload shape guard tests.
- `packages/flow-catalog/src/index.ts`: `FlowRecord` gains `inputs: WorkflowInput[]` and `planIrHash: string | null`; SQLite gains `inputs TEXT NOT NULL DEFAULT '[]'` and `plan_ir_hash TEXT` columns (ALTER with try/catch, matching existing migration pattern).
- `packages/flow-catalog/src/index.test.ts`: round-trip inputs + planIrHash.
- `packages/policy/src/index.ts`: `CapabilitySource` already has `version`; no change needed. (Contract is documentation-only at phase 0.)
- `apps/bridge/src/session-api.ts` + `apps/bridge/src/flow-api.ts`: `compileWorkflow` called with deterministic `definitionRevision` (sha256 of canonical definition); the compile tuple `(flowId, definitionRevision, planIrHash, compiledAt)` is stored via `FlowCatalogStore.save`.
- `docs/spec/RULES.md`: register PROTO rules for the new contracts.

Notes on deliberate exclusions (phase 0 is contracts only):
- No runtime enforcement of learning-signal payload schemas in `appendEvent` (payloads stay `Record<string, unknown>` in the store; strong TS types are the contract, schema validation arrives with the producers in phase 1).
- `capability_version` self-report already exists as `CapabilitySource.version` — no code change, just the RULES.md entry.
- `authorization_revision` producer (runner-host) is phase 1; phase 0 only defines the `Attribution` type field.

---

### Task 1: Canonical hash helper in workflow-engine

**Files:**
- Modify: `packages/workflow-engine/src/index.ts`
- Test: `packages/workflow-engine/src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/workflow-engine/src/index.test.ts` inside the top-level `describe`:

```ts
it("hashes structured content with RFC 8785 canonical JSON", () => {
  const a = definitionHash({ b: 1, a: { d: [2, 3], c: "x" } });
  const b = definitionHash({ a: { c: "x", d: [2, 3] }, b: 1 });
  expect(a).toBe(b);
  expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
});

it("hashes prompt templates from raw bytes without normalization", () => {
  const compact = promptHash("line1\nline2");
  const spaced = promptHash("line1\nline2 ");
  expect(compact).not.toBe(spaced);
});

it("produces a stable definition hash independent of key order", () => {
  const defA = {
    schema_version: 1, workflow_id: "diagnose", name: "Diagnose",
    kind: "runbook", status: "draft",
    steps: [{ id: "check", capability: "svc.check" }],
  };
  const defB = {
    steps: [{ capability: "svc.check", id: "check" }],
    status: "draft", kind: "runbook", name: "Diagnose",
    workflow_id: "diagnose", schema_version: 1,
  };
  expect(definitionHash(defA)).toBe(definitionHash(defB));
});
```

Add the import at the top of the test file:

```ts
import { definitionHash, promptHash } from "./index.js";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/workflow-engine/src/index.test.ts`
Expected: FAIL — `definitionHash is not a function` / module has no export.

- [ ] **Step 3: Implement canonical JSON + hashing**

In `packages/workflow-engine/src/index.ts`, add at the top:

```ts
import { createHash } from "node:crypto";
```

Append near the bottom (before `messageOf`):

```ts
/**
 * RFC 8785 (JCS) canonical JSON: keys sorted recursively, no insignificant
 * whitespace, UTF-8. Deterministic across key insertion order — this is the
 * only canonicalization allowed for structured contract content.
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

/** sha256 of RFC 8785 canonical JSON — for structured content (schemas, flow definitions, PlanIR). */
export function definitionHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

/** sha256 of raw bytes — for prompt templates where whitespace is semantically meaningful. */
export function promptHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/workflow-engine/src/index.test.ts`
Expected: PASS (all tests including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/index.ts packages/workflow-engine/src/index.test.ts
git commit -m "feat(workflow-engine): add RFC 8785 canonical hashing for contract content"
```

---

### Task 2: Typed inputs in workflow-engine

**Files:**
- Modify: `packages/workflow-engine/src/index.ts`
- Test: `packages/workflow-engine/src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/workflow-engine/src/index.test.ts`:

```ts
it("parses typed inputs with source and validation fields", () => {
  const def = parseWorkflow(`
schema_version: 1
workflow_id: equity-deliver
name: 权益交付
kind: runbook
status: draft
inputs:
  - id: company_id
    type: string
    required: true
    pattern: "^\\\\d{4,}$"
    source: user
  - id: env
    type: enum
    values: [test, production]
    default: test
    confirmation:
      when: "value == 'production'"
  - id: package_id
    type: string
    source: step_output
    from: steps.check.outputs.package_id
steps:
  - id: check
    capability: equity.check
`);
  expect(def.inputs).toHaveLength(3);
  expect(def.inputs[0]).toMatchObject({
    id: "company_id", type: "string", required: true,
    pattern: "^\\d{4,}$", source: "user",
  });
  expect(def.inputs[1]).toMatchObject({
    id: "env", type: "enum", values: ["test", "production"],
    default: "test", confirmation: { when: "value == 'production'" },
  });
  expect(def.inputs[2]).toMatchObject({
    id: "package_id", type: "string", source: "step_output",
    from: "steps.check.outputs.package_id",
  });
});

it("rejects an input with an unknown type", () => {
  expect(() => compileWorkflow({
    schema_version: 1, workflow_id: "w", name: "W", kind: "runbook", status: "draft",
    inputs: [{ id: "x", type: "float", source: "user" }],
    steps: [{ id: "s", capability: "c.d" }],
  })).toThrow(/type must be one of/);
});

it("rejects an enum input without values", () => {
  expect(() => compileWorkflow({
    schema_version: 1, workflow_id: "w", name: "W", kind: "runbook", status: "draft",
    inputs: [{ id: "env", type: "enum", source: "user" }],
    steps: [{ id: "s", capability: "c.d" }],
  })).toThrow(/values/);
});

it("rejects a step_output input without from", () => {
  expect(() => compileWorkflow({
    schema_version: 1, workflow_id: "w", name: "W", kind: "runbook", status: "draft",
    inputs: [{ id: "pkg", type: "string", source: "step_output" }],
    steps: [{ id: "s", capability: "c.d" }],
  })).toThrow(/from/);
});

it("rejects a pattern that does not compile as a regex", () => {
  expect(() => compileWorkflow({
    schema_version: 1, workflow_id: "w", name: "W", kind: "runbook", status: "draft",
    inputs: [{ id: "x", type: "string", source: "user", pattern: "([" }],
    steps: [{ id: "s", capability: "c.d" }],
  })).toThrow(/pattern/);
});

it("still accepts the legacy string[] inputs form", () => {
  const def = parseWorkflow(`
schema_version: 1
workflow_id: legacy
name: Legacy
kind: runbook
status: draft
inputs: [company_id, package_id]
steps:
  - id: s
    capability: c.d
`);
  expect(def.inputs).toEqual([
    { id: "company_id", type: "string", source: "user" },
    { id: "package_id", type: "string", source: "user" },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/workflow-engine/src/index.test.ts`
Expected: FAIL — typed inputs are rejected as "must be an array of strings".

- [ ] **Step 3: Add typed-input types**

In `packages/workflow-engine/src/index.ts`, after `WorkflowRetryPolicy`:

```ts
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
```

Change `WorkflowDefinition.inputs` from `string[]` to `WorkflowInput[]`.

- [ ] **Step 4: Normalize + validate typed inputs**

Replace `stringArrayField(input.inputs ?? [], "inputs", issues)` in BOTH `normalizeDefinition` and `normalizeCanonicalDefinition` with:

```ts
  const inputs = normalizeInputs(input.inputs ?? [], issues);
```

Add the normalizer functions (near `normalizeBranches`):

```ts
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
```

- [ ] **Step 5: Carry inputs into PlanIR**

In `PlanIR`, add after `definitionRevision`:

```ts
  inputs: WorkflowInput[];
```

In `compileWorkflow`'s return, add `inputs: definition.inputs.map((input) => ({ ...input })),`.

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run packages/workflow-engine/src/index.test.ts`
Expected: PASS. Also run `pnpm --filter @codebridge/workflow-engine build` — must compile clean. Then fix any downstream type errors from `inputs: string[]` → `WorkflowInput[]` (check `apps/bridge/src/flow-api.ts` and `session-api.ts` compile via `pnpm build`; adjust call sites that read `definition.inputs` as strings — `flow-api.ts` passes definitions straight to `compileWorkflow`, so it should be unaffected).

- [ ] **Step 7: Commit**

```bash
git add packages/workflow-engine/src/index.ts packages/workflow-engine/src/index.test.ts
git commit -m "feat(workflow-engine): typed flow inputs with source/pattern/enum/confirmation"
```

---

### Task 3: Learning-signal event contracts in work-items

**Files:**
- Modify: `packages/work-items/src/index.ts`
- Create: `packages/work-items/src/events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/work-items/src/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  SqliteEventStore,
  type Attribution,
  type ParamResolvedPayload,
  type FlowRejectedPayload,
  type RunSnapshotPayload,
  type VerificationFailedPayload,
} from "./index.js";

describe("learning-signal events", () => {
  it("accepts the four learning-signal event types", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "t", mode: "auto", conversationId: "c", riskLevel: "read_only",
    });
    const attribution: Attribution = {
      flow_revision: "sha256:plan",
      prompt_revision: "sha256:prompt",
      tool_schema_revision: "sha256:tools",
      capability_revisions: { "equity.deliver": "v3" },
      resolver_revision: "v1",
      authorization_revision: "sha256:auth",
    };
    const paramResolved: ParamResolvedPayload = {
      flow_id: "f", flow_revision: "sha256:plan", field: "company_id",
      candidate_value: "8821", final_value: "88214",
      resolution: "edited", source: "agent_extracted",
      evidence_ref: "evt_1", context: "权益交付",
    };
    const rejected: FlowRejectedPayload = {
      flow_id: "f", reason: "wrong_intent", user_chose: "freeform",
    };
    const failed: VerificationFailedPayload = {
      step_id: "deliver", category: "verification",
      postcondition: "output.equity_order_id != null",
      actual: {}, truncated: false,
    };
    const snapshot: RunSnapshotPayload = {
      flow_id: "f", flow_revision: "sha256:plan",
      resolved_inputs: [{
        field: "company_id", value: "88214", source: "user",
        resolver_version: "v1",
      }],
      steps: [{
        step_id: "deliver", capability_id: "equity.deliver",
        capability_revision: "v3", output_ref: "artifact://a1",
        verification_status: "passed",
      }],
      outcome: "succeeded",
      attribution,
    };
    for (const [type, payload] of [
      ["PARAM_RESOLVED", paramResolved],
      ["FLOW_REJECTED", rejected],
      ["VERIFICATION_FAILED", failed],
      ["RUN_SNAPSHOT", snapshot],
    ] as const) {
      const event = store.appendEvent({ workItemId: item.id, type, actor: "system", payload: payload as unknown as Record<string, unknown> });
      expect(event.type).toBe(type);
    }
    store.close();
  });

  it("rejects FLOW_REJECTED with a non-enum reason at the type level", () => {
    const bad: FlowRejectedPayload = {
      flow_id: "f",
      // @ts-expect-error reason must be the enum, not free text
      reason: "didn't feel like it",
    };
    expect(bad.flow_id).toBe("f");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/work-items/src/events.test.ts`
Expected: FAIL — `PARAM_RESOLVED` is not assignable to `DomainEventType`.

- [ ] **Step 3: Add event types and payload interfaces**

In `packages/work-items/src/index.ts`, extend `DomainEventType` (after `"WORK_ITEM_COMPLETED"` line, keep the union syntax):

```ts
  | "PARAM_RESOLVED"
  | "FLOW_RECOMMENDED"
  | "FLOW_REJECTED"
  | "RUN_SNAPSHOT"
```

(`VERIFICATION_FAILED` is not in the current union — check: the current union has `VERIFICATION_COMPLETED`. Add `"VERIFICATION_FAILED"` too.)

Then append the payload contracts at the end of the file:

```ts
// ---- Learning-signal payloads (docs/superpowers/specs/2026-08-13-flow-design.md §5.1) ----
// Strong schemas: these feed the data flywheel, dirty data cannot be learned from.

export type ParamResolution = "edited" | "picked_alternative" | "confirmed";

export interface ParamResolvedPayload {
  flow_id: string;
  flow_revision: string;
  field: string;
  candidate_value: unknown;
  final_value: unknown;
  resolution: ParamResolution;
  source: "user" | "agent_extracted" | "step_output" | "default" | `context.${string}`;
  /** Required when source is agent_extracted: links back to the conversation event. */
  evidence_ref?: string;
  context?: string;
  resolver_version?: string;
}

export interface FlowRecommendedPayload {
  flow_id: string;
  flow_revision: string;
  match_reason: string;
  confidence: number;
}

export type FlowRejectReason = "wrong_intent" | "missing_capability" | "bad_timing" | "other";

export interface FlowRejectedPayload {
  flow_id: string;
  reason: FlowRejectReason;
  note?: string;
  user_chose?: "freeform" | string;
}

export type VerificationFailureCategory = "verification" | "infrastructure" | "policy" | "llm_output";

export interface VerificationFailedPayload {
  step_id: string;
  category: VerificationFailureCategory;
  postcondition: string;
  /** Output summary, capped at 4KB serialized; truncated flags the cap was hit. */
  actual: unknown;
  truncated: boolean;
}

/** Attribution block: every variable that can change output, hashed (spec §5.2). */
export interface Attribution {
  /** plan_ir_hash — the compiled execution artifact, NOT the YAML hash. */
  flow_revision: string;
  prompt_revision: string;
  tool_schema_revision: string;
  capability_revisions: Record<string, string>;
  resolver_revision: string;
  authorization_revision: string;
}

export interface ResolvedInput {
  field: string;
  value: unknown;
  source: ParamResolvedPayload["source"];
  evidence_ref?: string;
  resolver_version: string;
  /** directory inputs must carry the authorization record ref. */
  authorization_ref?: string;
}

export interface DecisionTraceStep {
  step_id: string;
  capability_id: string;
  capability_revision: string;
  /** Must be an artifact:// reference; large outputs are never inlined. */
  output_ref: string;
  verification_status: "passed" | "failed" | "skipped";
}

export interface RunSnapshotPayload {
  flow_id: string;
  flow_revision: string;
  resolved_inputs: ResolvedInput[];
  steps: DecisionTraceStep[];
  outcome: "succeeded" | "failed";
  attribution: Attribution;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/work-items/src/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/work-items/src/index.ts packages/work-items/src/events.test.ts
git commit -m "feat(work-items): learning-signal event types and attribution contracts"
```

---

### Task 4: flow-catalog persists inputs and plan_ir_hash

**Files:**
- Modify: `packages/flow-catalog/src/index.ts`
- Test: `packages/flow-catalog/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/flow-catalog/src/index.test.ts`:

```ts
  it("persists typed inputs and the compile-tuple plan_ir_hash", () => {
    const store = new FlowCatalogStore(":memory:");
    const flow = store.save({
      flowId: "flow-typed",
      name: "Typed",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: "sha256:def",
      planIrHash: "sha256:plan",
      inputs: [
        { id: "company_id", type: "string", required: true, source: "user", pattern: "^\\d{4,}$" },
        { id: "env", type: "enum", source: "user", values: ["test", "production"], default: "test", confirmation: { when: "value == 'production'" } },
      ],
      steps: [{ id: "deliver", capability: "equity.deliver" }],
    });
    const loaded = store.get("flow-typed");
    expect(loaded?.planIrHash).toBe("sha256:plan");
    expect(loaded?.inputs).toEqual(flow.inputs);
    expect(loaded?.inputs[0]).toMatchObject({ pattern: "^\\d{4,}$" });
    store.close();
  });
```

Add the type import at top: `import type { WorkflowInput } from "@codebridge/workflow-engine";` — wait: flow-catalog has no dependency on workflow-engine and adding one creates a cycle risk (bridge depends on both; engine depends on neither — safe, but simpler to define the input type independently). Instead define a local structural type in the test inline as shown (no import needed — the test passes plain objects).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/flow-catalog/src/index.test.ts`
Expected: FAIL — `planIrHash`/`inputs` are unknown properties and are dropped.

- [ ] **Step 3: Add columns, fields, and mapping**

In `packages/flow-catalog/src/index.ts`:

1. After `export interface FlowStep`, add:

```ts
export interface FlowInput {
  id: string;
  type: "string" | "integer" | "enum" | "directory" | "secret_ref";
  source: "user" | "context" | "agent" | "step_output" | "default";
  required?: boolean;
  pattern?: string;
  values?: string[];
  default?: string;
  confirmation?: { when: string };
  from?: string;
  scope?: "authorized_folders";
}
```

(Declared locally to keep `flow-catalog` dependency-free; structurally identical to `WorkflowInput` — the bridge maps between them at the boundary.)

2. In `FlowRecord`, after `definitionRevision: string;` add:

```ts
  planIrHash: string | null;
  inputs: FlowInput[];
```

3. In the constructor's migration loop, add two statements:

```ts
      "ALTER TABLE flows ADD COLUMN plan_ir_hash TEXT",
      "ALTER TABLE flows ADD COLUMN inputs TEXT NOT NULL DEFAULT '[]'",
```

4. In `save()`: extend the `input` type's `Omit` to also omit `"planIrHash" | "inputs"` and the `Partial` pick to include them; build the record with:

```ts
      planIrHash: input.planIrHash ?? current?.planIrHash ?? null,
      inputs: (input.inputs ?? current?.inputs ?? []).map((value) => ({ ...value })),
```

5. Update the SQL in `save()`: add `plan_ir_hash` and `inputs` to both the INSERT column list/VALUES and the ON CONFLICT update list, passing `record.planIrHash` and `JSON.stringify(record.inputs)`.

6. In `toFlow()`, add:

```ts
    planIrHash: row.plan_ir_hash === null || row.plan_ir_hash === undefined ? null : String(row.plan_ir_hash),
    inputs: JSON.parse(String(row.inputs ?? "[]")) as FlowInput[],
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/flow-catalog/src/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flow-catalog/src/index.ts packages/flow-catalog/src/index.test.ts
git commit -m "feat(flow-catalog): persist typed inputs and plan_ir_hash compile tuple"
```

---

### Task 5: Bridge compiles with deterministic revision and stores the tuple

**Files:**
- Modify: `apps/bridge/src/flow-api.ts`
- Test: `apps/bridge/src/flow-api.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/bridge/src/flow-api.test.ts`, append inside the main describe:

```ts
  it("stores definitionRevision as a deterministic content hash and records plan_ir_hash", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const app = createFlowApp(catalog, "token", { sessions });
    const definition = {
      schema_version: 1,
      workflow_id: "equity-deliver",
      name: "权益交付",
      kind: "runbook",
      status: "candidate",
      inputs: [{ id: "company_id", type: "string", source: "user" }],
      steps: [{ id: "deliver", capability: "equity.deliver" }],
    };
    const headers = { authorization: `****** "content-type": "application/json" };
    const response = await app.request("/v1/flows", {
      method: "POST",
      headers,
      body: JSON.stringify(definition),
    });
    expect(response.status).toBe(201);
    const flow = catalog.get("equity-deliver");
    expect(flow?.definitionRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(flow?.planIrHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(flow?.definitionRevision).not.toBe(flow?.planIrHash);
    // Re-saving the byte-identical definition keeps both hashes stable.
    await app.request("/v1/flows", { method: "POST", headers, body: JSON.stringify(definition) });
    expect(catalog.get("equity-deliver")?.definitionRevision).toBe(flow?.definitionRevision);
    sessions.close();
    catalog.close();
  });
```

First check the existing `POST /v1/flows` route signature in `flow-api.ts` (the test above assumes it accepts a raw definition body; if it expects `{ definition: ... }` or a different envelope, adjust the test to match the existing route's actual request shape).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/bridge/src/flow-api.test.ts`
Expected: FAIL — `definitionRevision` is currently caller-supplied or absent, and `planIrHash` is not stored.

- [ ] **Step 3: Implement deterministic compile tuple**

In `apps/bridge/src/flow-api.ts`:

1. Import the hash helpers:

```ts
import { compileWorkflow, definitionHash, WorkflowValidationError } from "@codebridge/workflow-engine";
```

2. In the create/save handler, replace whatever sets `definitionRevision` with:

```ts
      const definitionRevision = definitionHash(definition);
      let plan;
      try {
        plan = compileWorkflow(definition, { source: "workflow", definitionRevision });
      } catch (error) {
        if (error instanceof WorkflowValidationError) {
          return c.json({ error: "invalid_flow", issues: error.issues }, 409);
        }
        throw error;
      }
      const planIrHash = definitionHash(plan);
      catalog.save({
        flowId: definition.workflow_id,
        name: definition.name,
        kind: definition.kind,
        status: definition.status,
        source: "user_selected",
        definitionRevision,
        planIrHash,
        inputs: plan.inputs,
        steps: definition.steps,
      });
```

(Adapt field names to the existing save call in the route; the essentials: `definitionRevision` = `definitionHash(definition)` BEFORE compile, `planIrHash` = `definitionHash(plan)` AFTER compile, `inputs` from the compiled plan.)

3. In `apps/bridge/src/session-api.ts` where `compileWorkflow` is called for runs (search `compileWorkflow(`), ensure it passes the flow's stored `definitionRevision` (it already does via `flow.definitionRevision` — verify) and that after this change the stored revision is the content hash. No other change needed there in phase 0.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/bridge/src/flow-api.test.ts`
Expected: PASS. Then `pnpm build` for type-check across packages.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src/flow-api.ts apps/bridge/src/flow-api.test.ts
git commit -m "feat(bridge): freeze flow compile tuple with content-hash revisions"
```

---

### Task 6: Register contract rules in RULES.md

**Files:**
- Modify: `docs/spec/RULES.md`

- [ ] **Step 1: Read the existing rule format**

Run: `grep -n "PROTO-" docs/spec/RULES.md | tail -10` and match the existing entry style.

- [ ] **Step 2: Append the new rules**

Add entries covering:

```markdown
| PROTO-FLOW-INPUT-001 | Flow inputs are typed objects (id/type/source required; pattern/values/confirmation/from by type); legacy `string[]` shorthand normalizes to `{type: string, source: user}`. | packages/workflow-engine/src/index.ts |
| PROTO-FLOW-REVISION-001 | definitionRevision = sha256 of RFC 8785 canonical definition; plan_ir_hash = sha256 of canonical PlanIR; both stored at compile time; runtime never reparses YAML. | packages/workflow-engine/src/index.ts, apps/bridge/src/flow-api.ts |
| PROTO-FLOW-ATTR-001 | RUN_SNAPSHOT carries the attribution block (flow_revision=plan_ir_hash, prompt_revision, tool_schema_revision, capability_revisions, resolver_revision, authorization_revision). capability_version is self-reported in the manifest. | packages/work-items/src/index.ts |
| PROTO-FLOW-SIGNAL-001 | Learning-signal events (PARAM_RESOLVED, FLOW_RECOMMENDED, FLOW_REJECTED, VERIFICATION_FAILED, RUN_SNAPSHOT) have strong payload types; FLOW_REJECTED.reason is an enum; VERIFICATION_FAILED.actual is capped at 4KB with truncated flag. | packages/work-items/src/index.ts |
| PROTO-FLOW-HASH-001 | Canonical form is RFC 8785 for structured content and raw bytes for prompt templates; no other canonicalization is allowed. | packages/workflow-engine/src/index.ts |
```

- [ ] **Step 3: Commit**

```bash
git add docs/spec/RULES.md
git commit -m "docs(spec): register flow phase-0 contract rules"
```

---

## Self-review checklist (already run)

- **Spec coverage:** §5.1 events → Task 3; §5.2 hashing/attribution → Tasks 1+3; §5.3 typed inputs → Task 2; compile tuple §6.2 → Tasks 4+5; capability_version self-report → existing `CapabilitySource.version` (RULES.md entry only). Phase-1 items (success_when runtime, dry-run, idempotency, replay) intentionally absent — that's plan B.
- **No placeholders:** every code step contains complete code; Task 5 Step 1 has one conditional note about matching the existing route envelope — the engineer must read `flow-api.ts` first (by design, since the route's exact current body shape must be preserved).
- **Type consistency:** `WorkflowInput` (engine) vs `FlowInput` (catalog) are deliberately separate structural types with identical fields — the mapping happens at the bridge boundary; both names are used consistently throughout.
- **Known follow-up for plan B:** `appendEvent` does not yet validate learning-signal payloads at runtime; producers introduced in phase 1 should validate before append.
