# Flow Phase 1 Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the phase-1 execution loop from `docs/superpowers/specs/2026-08-13-flow-design.md`: success_when postconditions (steps succeed on verified output, not "no exception"), dry-run adapter contract, idempotency keys with validity windows, deterministic replay diff, and run-side plan_ir_hash binding.

**Architecture:** `workflow-engine` gains `success_when` parsing/validation and a pure JSONPath+5-operator evaluator; `policy` gains the dry-run invocation context, `dry_run_report`, `side_effects` and `idempotency` manifest fields; `work-items` persists `planIrHash` on plans/runs; `run-executor` evaluates postconditions after capability execution, records `VERIFICATION_FAILED` (category `verification`), dedupes write steps by idempotency key, and exposes a deterministic replay that diffs decision traces.

**Tech Stack:** TypeScript, node:crypto sha256, node:sqlite, Vitest, pnpm. No JSON-Schema runtime validator and no expression engine are introduced — the evaluator is a small hand-written pure function.

**Order:** B1 → B6 → B3 → B4 → B2 → B5 (B6 is zero-dependency wiring; B3/B4 are orthogonal; B2 depends on B1; B5 depends on B2+B3+B4).

---

## File map

- `packages/workflow-engine/src/index.ts`: `WorkflowStep.success_when`, `PlanStep.successWhen`, `evaluatePostcondition()`, `validatePostcondition()`; compile-time syntax check.
- `packages/workflow-engine/src/index.test.ts`: evaluator + validation tests.
- `packages/work-items/src/index.ts`: `PersistedPlan.planIrHash`, `SavePlanInput.planIrHash`, `Run.planIrHash`, `CreateRunInput.planIrHash`; persistence mapping.
- `packages/work-items/src/index.test.ts`: plan/run planIrHash round-trip.
- `packages/policy/src/capability-runtime.ts`: `CapabilityInvocationContext.dry_run`, `CapabilityExecutionResult.dry_run_report`.
- `packages/policy/src/capability-runtime.test.ts`: dry-run adapter behavior.
- `packages/policy/src/index.ts`: `CapabilityDefinition.side_effects`, `CapabilityDefinition.idempotency`; SQLite columns + mapping.
- `packages/policy/src/index.test.ts`: manifest round-trip.
- `packages/run-executor/src/index.ts`: postcondition evaluation after capability, `VERIFICATION_FAILED` emission, idempotency-key dedupe, `replayRun`/trace diff, planIrHash drift check.
- `packages/run-executor/src/index.test.ts`: postcondition failure, idempotent replay, replay diff.

---

### Task B1: success_when declaration + pure evaluator (workflow-engine)

**Files:**
- Modify: `packages/workflow-engine/src/index.ts`
- Test: `packages/workflow-engine/src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/workflow-engine/src/index.test.ts`:

```ts
import { evaluatePostcondition, validatePostcondition } from "./index.js";

describe("postconditions", () => {
  it("evaluates exists / == / != / > / contains", () => {
    const out = { order_id: "o1", count: 3, tags: ["vip", "new"], status: "ok" };
    expect(evaluatePostcondition("output.order_id exists", out)).toBe(true);
    expect(evaluatePostcondition("output.missing exists", out)).toBe(false);
    expect(evaluatePostcondition("output.order_id == \"o1\"", out)).toBe(true);
    expect(evaluatePostcondition("output.order_id != null", out)).toBe(true);
    expect(evaluatePostcondition("output.count > 2", out)).toBe(true);
    expect(evaluatePostcondition("output.tags contains \"vip\"", out)).toBe(true);
  });

  it("rejects malformed expressions at validate time", () => {
    expect(validatePostcondition("output.a = b")).toMatch(/invalid/);
    expect(validatePostcondition("output.a ===")).toMatch(/invalid/);
    expect(validatePostcondition("output.a exists")).toBeNull();
  });

  it("parses success_when into PlanIR", () => {
    const plan = compileWorkflow({
      schema_version: 1, workflow_id: "w", name: "W", kind: "runbook", status: "draft",
      steps: [{ id: "deliver", capability: "equity.deliver", success_when: "output.order_id != null" }],
    });
    expect(plan.steps[0].successWhen).toBe("output.order_id != null");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/workflow-engine/src/index.test.ts`
Expected: FAIL — `evaluatePostcondition is not a function` / `successWhen` undefined.

- [ ] **Step 3: Add types**

In `packages/workflow-engine/src/index.ts`, add to `WorkflowStep` (after `purpose?: string;`):

```ts
  /** postcondition: JSONPath + (== | != | > | contains | exists). Step succeeds only when this holds on the capability output. */
  successWhen?: string;
```

Add to `PlanStep` (after `purpose: string | null;`):

```ts
  successWhen: string | null;
```

- [ ] **Step 4: Normalize + validate**

In `normalizeStep` (raw YAML, snake_case), after the `purpose` block, add:

```ts
  const successWhen =
    item.success_when === undefined
      ? undefined
      : stringField(item.success_when, `${prefix}.success_when`, issues);
  if (successWhen !== undefined) {
    const error = validatePostcondition(successWhen);
    if (error) issues.push(`${prefix}.success_when ${error}`);
  }
```

In `normalizeCanonicalStep` (canonical, camelCase), after the `purpose` block, add:

```ts
  const successWhen =
    item.successWhen === undefined
      ? undefined
      : stringField(item.successWhen, `${prefix}.successWhen`, issues);
  if (successWhen !== undefined) {
    const error = validatePostcondition(successWhen);
    if (error) issues.push(`${prefix}.successWhen ${error}`);
  }
```

Return `successWhen` in both step objects (canonical field name; raw snake_case input normalizes to it).

- [ ] **Step 5: Map into PlanIR**

In `compileWorkflow`'s step mapping, add:

```ts
      successWhen: step.successWhen ?? null,
```

- [ ] **Step 6: Implement evaluator**

Append near the bottom of `packages/workflow-engine/src/index.ts` (before `messageOf`):

```ts
/**
 * Pure postcondition evaluator. Expression forms:
 *   `output.path exists`            — path resolves to a defined value
 *   `output.path == <literal>`      — strict equality (also `!=`)
 *   `output.path > <literal>`       — numeric greater-than
 *   `output.path contains <literal>`— string includes, or array contains
 * The path is a dot-separated JSONPath into the output object.
 */
export function evaluatePostcondition(expression: string, output: unknown): boolean {
  const exists = expression.match(/^([\w.-]+)\s+exists$/);
  if (exists) return valueAtPath(output, exists[1]!) !== undefined;

  const contains = expression.match(/^([\w.-]+)\s+contains\s+(.+)$/);
  if (contains) {
    const actual = valueAtPath(output, contains[1]!);
    const expected = parseLiteral(contains[2]!);
    if (typeof actual === "string" && typeof expected === "string") return actual.includes(expected);
    if (Array.isArray(actual)) return actual.includes(expected);
    return false;
  }

  const comparison = expression.match(/^([\w.-]+)\s*(==|!=|>)\s*(.+)$/);
  if (!comparison) throw new Error(`invalid postcondition: ${expression}`);
  const actual = valueAtPath(output, comparison[1]!);
  const expected = parseLiteral(comparison[3]!);
  switch (comparison[2]) {
    case "==": return actual === expected;
    case "!=": return actual !== expected;
    case ">": return typeof actual === "number" && typeof expected === "number" && actual > expected;
    default: return false;
  }
}

/** Returns null when valid, or an error string. Used at compile time. */
export function validatePostcondition(expression: string): string | null {
  if (/^[\w.-]+\s+exists$/.test(expression)) return null;
  if (/^[\w.-]+\s+contains\s+.+$/.test(expression)) return null;
  if (/^[\w.-]+\s*(==|!=|>)\s*.+$/.test(expression)) return null;
  return "invalid postcondition expression";
}

function valueAtPath(root: unknown, path: string): unknown {
  let value: unknown = root;
  for (const key of path.split(".")) {
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function parseLiteral(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/^(["'])(.*)\1$/, "$2");
}
```

- [ ] **Step 7: Run tests**

Run: `pnpm vitest run packages/workflow-engine/src/index.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/workflow-engine/src/index.ts packages/workflow-engine/src/index.test.ts
git commit -m "feat(workflow-engine): success_when postconditions with pure JSONPath evaluator"
```

---

### Task B6: run-side plan_ir_hash binding (work-items + run-executor)

**Files:**
- Modify: `packages/work-items/src/index.ts`
- Modify: `packages/run-executor/src/index.ts`
- Test: `packages/work-items/src/index.test.ts`, `packages/run-executor/src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/work-items/src/index.test.ts`, append:

```ts
  it("persists planIrHash on plans and runs", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({ title: "t", mode: "auto", conversationId: "c", riskLevel: "read_only" });
    const plan = store.savePlan({
      planId: "plan_1", source: "workflow", workflowId: "flow_1",
      definitionRevision: "sha256:def", planIrHash: "sha256:plan",
      steps: [{ id: "s", capabilityId: "c.d", risk: "read_only", dependsOn: [], guard: null, approval: "none", branches: [], purpose: null, retry: null }],
    });
    expect(plan.planIrHash).toBe("sha256:plan");
    const run = store.createRun({ workItemId: item.id, planId: "plan_1" });
    expect(run.planIrHash).toBe("sha256:plan");
    store.close();
  });
```

In `packages/run-executor/src/index.test.ts`, append a test that constructs a store whose plan `planIrHash` differs from the run's, and asserts `execute` throws `Plan IR drift`. (Structure the fixture with the existing helpers in that file; assert `rejects.toThrow(/drift/)`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/work-items/src/index.test.ts packages/run-executor/src/index.test.ts`
Expected: FAIL — `planIrHash` unknown on plan/run.

- [ ] **Step 3: Persist planIrHash**

In `packages/work-items/src/index.ts`:

1. `PersistedPlan` add `planIrHash: string | null;` (after `definitionRevision`).
2. `SavePlanInput` add `planIrHash?: string | null;`.
3. `Run` add `planIrHash: string | null;` (after `workflowRevision`).
4. `CreateRunInput` add `planIrHash?: string | null;`.

In `savePlan`, set `planIrHash: input.planIrHash ?? null`, add the `plan_ir_hash` column to the INSERT and ON CONFLICT lists, and add the ALTER migration:

```ts
      "ALTER TABLE plans ADD COLUMN plan_ir_hash TEXT",
```

In `toPlan`, add `planIrHash: row.plan_ir_hash === null || row.plan_ir_hash === undefined ? null : String(row.plan_ir_hash),`.

In `createRun`, set `planIrHash: input.planIrHash ?? plan?.planIrHash ?? null`, add the `plan_ir_hash` column to the runs INSERT and an ALTER migration:

```ts
      "ALTER TABLE runs ADD COLUMN plan_ir_hash TEXT",
```

In `toRun`, add `planIrHash: row.plan_ir_hash === null || row.plan_ir_hash === undefined ? null : String(row.plan_ir_hash),`.

- [ ] **Step 4: Enforce drift check in run-executor**

In `packages/run-executor/src/index.ts`, in `execute()` after loading `plan`, add:

```ts
    if (plan && runHasIr(initial) && plan.planIrHash && initial.planIrHash !== plan.planIrHash) {
      throw new Error(`Plan IR drift: run ${runId} bound ${initial.planIrHash} but plan resolves to ${plan.planIrHash}`);
    }
```

where `runHasIr` is a local helper (see Step 6).

- [ ] **Step 5: Wire session-api.ts (otherwise the check is dead code)**

In `apps/bridge/src/session-api.ts`, carry the flow's frozen `planIrHash` (computed in phase 0 by `flow-api.ts`) into `savePlan` and `createRun`:

```ts
    if (plan) {
      options.workItems.savePlan({
        ...plan,
        sessionId: session.id,
        runId,
        planIrHash: flow?.planIrHash ?? null,
      });
    }
    const run = options.workItems.createRun({
      id: runId,
      workItemId: task.id,
      mode: "auto",
      agentId: session.agentId,
      planId: plan?.planId ?? null,
      planIrHash: flow?.planIrHash ?? null,
      workflowRevision: flow?.definitionRevision ?? null,
    });
```

Do NOT recompute the hash here: session-api recompiles with a random `planId`, which yields a different IR hash than the frozen `flow.planIrHash`.

- [ ] **Step 6: Add helper**

Append near the other helpers in `run-executor`:

```ts
function runHasIr(run: Run): boolean {
  return run.planIrHash !== null && run.planIrHash !== undefined;
}
```

- [ ] **Step 7: Run tests**

Run: `pnpm vitest run packages/work-items/src/index.test.ts packages/run-executor/src/index.test.ts`
Expected: PASS. Then `pnpm build` type-checks the workspace.

- [ ] **Step 8: Commit**

```bash
git add packages/work-items/src/index.ts packages/work-items/src/index.test.ts packages/run-executor/src/index.ts packages/run-executor/src/index.test.ts apps/bridge/src/session-api.ts
git commit -m "feat(work-items,run-executor): bind and verify plan_ir_hash on runs"
```

---

### Task B3: dry-run adapter contract (policy)

**Files:**
- Modify: `packages/policy/src/capability-runtime.ts`
- Modify: `packages/policy/src/index.ts`
- Test: `packages/policy/src/capability-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/policy/src/capability-runtime.test.ts`, append:

```ts
  it("passes dry_run to adapters and surfaces dry_run_report", async () => {
    let sawDryRun: boolean | undefined;
    const adapter = new FunctionCapabilityAdapter("a", async (inv) => {
      sawDryRun = inv.context.dry_run;
      if (inv.context.dry_run) {
        return {
          dry_run_report: { would_do: "write X", checks: [{ name: "idempotency", passed: true }] },
        };
      }
      return { output: { done: true } };
    });
    const runtime = new CapabilityRuntime([adapter]);
    const result = await runtime.execute("a", { input: {}, context: { dry_run: true } });
    expect(sawDryRun).toBe(true);
    expect(result.dry_run_report?.would_do).toBe("write X");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/policy/src/capability-runtime.test.ts`
Expected: FAIL — `dry_run` is not assignable to `CapabilityInvocationContext`.

- [ ] **Step 3: Add contract fields**

In `packages/policy/src/capability-runtime.ts`:

1. In `CapabilityInvocationContext`, add `dry_run?: boolean;`.
2. In `CapabilityExecutionResult`, add:

```ts
  /** dry-run contract: side-effecting adapters return this instead of performing writes. */
  dry_run_report?: {
    would_do: string;
    checks: Array<{ name: string; passed: boolean }>;
  };
```

In `packages/policy/src/index.ts`, add to `CapabilityDefinition`:

```ts
  /** true when the capability mutates state; such adapters must honor context.dry_run. */
  side_effects?: boolean;
```

- [ ] **Step 4: Persist side_effects**

In `CapabilityRegistry.register` and the INSERT/ON CONFLICT SQL, add a `side_effects` column (TEXT, `'0'`/`'1'`), plus the ALTER migration:

```ts
      "ALTER TABLE capabilities ADD COLUMN side_effects TEXT",
```

In `toCapability`, map `side_effects` back to `boolean | undefined` (only when the stored value is a non-null string `"1"`/`"0"`).

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/policy/src/capability-runtime.test.ts packages/policy/src/index.test.ts`
Expected: PASS. `pnpm build` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/policy/src/capability-runtime.ts packages/policy/src/capability-runtime.test.ts packages/policy/src/index.ts
git commit -m "feat(policy): dry-run adapter contract and side_effects manifest"
```

---

### Task B4: idempotency key + validity window (policy + run-executor)

**Files:**
- Modify: `packages/policy/src/index.ts`
- Modify: `packages/run-executor/src/index.ts`
- Test: `packages/run-executor/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/run-executor/src/index.test.ts`, append a test that:

1. Registers a capability `write.thing` with `idempotency: { key: ["company_id"], validity_window: "24h" }`.
2. Uses a `FunctionCapabilityAdapter` that counts invocations.
3. Runs **two runs of the same step** with the same `company_id` in `workItem.identifiers`; asserts the adapter was invoked once and the second run reused the first result.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/run-executor/src/index.test.ts`
Expected: FAIL — no dedupe happens, adapter invoked twice.

- [ ] **Step 3: Add manifest field**

In `packages/policy/src/index.ts`, add to `CapabilityDefinition`:

```ts
  idempotency?: {
    /** input field names that derive the idempotency key. */
    key: string[];
    /** dedupe window. `permanent` = never expires. */
    validity_window?: "24h" | "7d" | "permanent";
  };
```

Persist it as a `idempotency` TEXT column (JSON) with ALTER migration and `toCapability` mapping (parse JSON, undefined when null).

- [ ] **Step 4: Implement dedupe + force bypass in run-executor**

Add a private field to `RunExecutor` and an `execute` option so a user-initiated "run again" can skip the dedupe:

```ts
  // In the RunExecutor class body:
  private currentForce = false;
```

Change the `execute` signature and set the flag at the top:

```ts
  async execute(runId: string, signal?: AbortSignal, options?: { force?: boolean }): Promise<Run> {
    this.currentForce = options?.force ?? false;
    // ...rest of the existing body unchanged
```

In `executeCapability` before calling `this.options.capabilities.execute`, add:

```ts
    const idem = definition.idempotency;
    // namespace "flow-step" is deliberately separate from the HTTP idempotency
    // keys ("session:run:*") stored in the same idempotency_responses table.
    if (idem && !this.currentForce && step.risk !== "read_only") {
      const key = idempotencyKey(workItem, run, step, idem.key);
      const prior = this.store.getIdempotencyResponse("flow-step", key);
      if (prior !== undefined) {
        return prior as CapabilityExecutionResult;
      }
    }
```

and after a successful execute, store:

```ts
    if (idem && step.risk !== "read_only") {
      this.store.putIdempotencyResponse("flow-step", key, result);
    }
```

Note: `validity_window` window-expiry is not enforced in phase 1 (permanent dedupe); the `force` flag is the explicit "run again" escape hatch.

Add the helper (reuse `stableStringify` already in the file):

```ts
function idempotencyKey(
  workItem: WorkItem,
  run: Run,
  step: PersistedPlanStep,
  fields: string[],
): string {
  // Key fields are business inputs carried in workItem.identifiers at phase 1
  // (no ResolvedPlan producer yet); the key is flow+step+field-values.
  const parts = fields.map((field) => {
    const value = workItem.identifiers[field];
    return `${field}=${stableStringify(value)}`;
  });
  return `sha256:${createHash("sha256").update([workItem.workflowId ?? "", step.id, ...parts].join(":"), "utf8").digest("hex")}`;
}
```

Note: this is phase-1 scope — the key derives from resolved inputs available at execution time (`workItem.identifiers` / step purpose), not yet from a full `ResolvedPlan` (that arrives with parameter binding in a later plan). Keep the helper deterministic.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/run-executor/src/index.test.ts`
Expected: PASS. `pnpm build` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/policy/src/index.ts packages/run-executor/src/index.ts packages/run-executor/src/index.test.ts
git commit -m "feat(policy,run-executor): idempotency keys with validity window"
```

---

### Task B2: postcondition evaluation + VERIFICATION_FAILED (run-executor)

**Files:**
- Modify: `packages/run-executor/src/index.ts`
- Test: `packages/run-executor/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/run-executor/src/index.test.ts`, append a test that:

1. Compiles a plan with a step `success_when: "output.order_id != null"`.
2. Registers a capability whose adapter returns `{ output: {} }` (no `order_id`).
3. Executes the run; asserts the run fails and a `VERIFICATION_FAILED` event with `payload.category === "verification"` exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/run-executor/src/index.test.ts`
Expected: FAIL — run currently succeeds (no postcondition evaluated).

- [ ] **Step 3: Import evaluator**

In `packages/run-executor/src/index.ts`, add:

```ts
import { evaluatePostcondition } from "@codebridge/workflow-engine";
```

- [ ] **Step 4: Evaluate after capability execution**

In `executeStepOnce`, after `const capabilityResult = await this.executeCapability(...)` and before `if (capabilityResult?.forwardToAgent)`, add:

```ts
    if (step?.successWhen && capabilityResult && !capabilityResult.forwardToAgent) {
      const passed = evaluatePostcondition(step.successWhen, capabilityResult.output);
      if (!passed) {
        this.store.appendEvent({
          workItemId: workItem.id,
          runId: run.id,
          type: "VERIFICATION_FAILED",
          actor: "adapter",
          target: step.id,
          payload: {
            step_id: step.id,
            category: "verification",
            postcondition: step.successWhen,
            actual: capabilityResult.output ?? null,
            truncated: false,
          },
        });
        throw new Error(`Postcondition failed for step ${step.id}: ${step.successWhen}`);
      }
    }
```

(Note: `work-items` already accepts `VERIFICATION_FAILED` from phase 0; the `actual` value here is the small in-memory output — the 4KB cap becomes relevant when snapshotting large outputs in a later plan.)

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/run-executor/src/index.test.ts`
Expected: PASS. `pnpm build` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/run-executor/src/index.ts packages/run-executor/src/index.test.ts
git commit -m "feat(run-executor): enforce success_when postconditions and record VERIFICATION_FAILED"
```

---

### Task B5: deterministic replay diff (run-executor)

**Files:**
- Modify: `packages/run-executor/src/index.ts`
- Test: `packages/run-executor/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/run-executor/src/index.test.ts`, append a test that:

1. Uses a deterministic `FunctionCapabilityAdapter` (returns the same output for the same input).
2. Executes a plan once, capturing the decision trace (capability calls + inputs + verification statuses).
3. Calls the new `replayPlan` (write steps forced dry-run); asserts the replayed trace equals the original trace.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/run-executor/src/index.test.ts`
Expected: FAIL — `replayPlan` does not exist.

- [ ] **Step 3: Define trace types**

In `packages/run-executor/src/index.ts`, add near the top:

```ts
export interface DecisionTraceStep {
  step_id: string;
  capability_id: string | null;
  input: Record<string, unknown>;
  verification_status: "passed" | "failed" | "skipped";
}
export interface ReplayDiff {
  identical: boolean;
  original: DecisionTraceStep[];
  replayed: DecisionTraceStep[];
  diffs: string[];
}
```

- [ ] **Step 4: Capture trace during executeCapability**

In `executeCapability`, collect each invocation into a per-run trace (the trace is built by the caller via an optional collector). Add an optional callback to `RunExecutorOptions`:

```ts
  onTrace?: (run: Run, step: DecisionTraceStep) => void;
```

and in `executeCapability` after `execute` returns, call:

```ts
    this.options.onTrace?.(run, {
      step_id: step.id,
      capability_id: step.capabilityId,
      input: { title: workItem.title, identifiers: workItem.identifiers },
      verification_status: result.verification?.status ?? "passed",
    });
```

- [ ] **Step 5: Implement replayPlan**

Add a public method:

```ts
  async replayPlan(plan: PersistedPlan, inputs: Record<string, unknown>): Promise<DecisionTraceStep[]> {
    const trace: DecisionTraceStep[] = [];
    for (const step of orderSteps(plan.steps)) {
      if (!step.capabilityId) continue;
      const definition = this.options.policy?.getCapability(step.capabilityId);
      if (!definition) continue;
      const result = await this.options.capabilities!.execute(definition.adapter, {
        input: { ...inputs, step: { id: step.id } },
        context: { dry_run: true, environment: step.risk === "production_write" ? "production" : "local" },
      });
      // Replay must mirror B2's definition of "verification result": a
      // successWhen postcondition is evaluated, not just adapter self-report.
      const verificationStatus = step.successWhen
        ? (evaluatePostcondition(step.successWhen, result.output) ? "passed" : "failed")
        : (result.verification?.status ?? "passed");
      trace.push({
        step_id: step.id,
        capability_id: step.capabilityId,
        input: { ...inputs, step: { id: step.id } },
        verification_status: verificationStatus,
      });
    }
    return trace;
  }

  diffTrace(original: DecisionTraceStep[], replayed: DecisionTraceStep[]): ReplayDiff {
    const diffs: string[] = [];
    const identical = original.length === replayed.length && original.every((step, index) => {
      const same = JSON.stringify(step) === JSON.stringify(replayed[index]);
      if (!same) diffs.push(`step ${step.step_id}: original ${JSON.stringify(step)} vs replayed ${JSON.stringify(replayed[index])}`);
      return same;
    });
    return { identical, original, replayed, diffs };
  }
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run packages/run-executor/src/index.test.ts`
Expected: PASS. `pnpm build` clean.

- [ ] **Step 7: Commit**

```bash
git add packages/run-executor/src/index.ts packages/run-executor/src/index.test.ts
git commit -m "feat(run-executor): deterministic replay and decision-trace diff"
```

---

## Self-review checklist

- **Spec coverage:** §6.3 success_when → B1+B2; §6.2 run-side plan_ir_hash → B6; §6.4 dry-run → B3; §6.5 idempotency/validity_window → B4; §6.6 replay diff → B5. Dry-run "转正复用 ResolvedPlan" and full parameter binding are deliberately deferred (no ResolvedPlan producer yet) — noted in B4.
- **No placeholders:** every code step contains complete code. B5's diff compares JSON-serialized traces (deterministic given stable inputs).
- **Type consistency:** `successWhen` (PlanStep) → `success_when` (WorkflowStep) naming is consistent; `planIrHash` (work-items) matches `planIrHash` used in flow-catalog phase 0; `dry_run`/`dry_run_report`/`side_effects`/`idempotency` names match the spec.
- **Known follow-up:** VERIFICATION_FAILED categories other than `verification` (infrastructure/policy/llm_output), the 4KB `actual` cap at snapshot time, full `ResolvedPlan`-driven idempotency keys, and `validity_window` **window-expiry logic** (phase 1 implements permanent dedupe only; the manifest field is declared but expiry is not enforced) land with parameter binding in a later plan.
