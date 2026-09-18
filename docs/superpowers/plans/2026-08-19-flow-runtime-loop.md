# Flow Runtime Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Web main path (select published runbook → send message) a real Runtime loop: lossless recompile + hash gate, no Agent fallback, structured missing inputs, learning-signal events, and `executeCapability` dry-run — per `docs/superpowers/specs/2026-08-19-flow-runtime-loop-design.md`.

**Architecture:** One lossless compile helper is the only way catalog records become PlanIR (save and execute). RunExecutor owns step execution: plan steps never call `runner.run`; `dry_run` is a flag on the same `executeCapability`. Bridge boot registers `demo.echo` / `demo.concat`. Publish rejects manual/skill and uncovered capabilities. `replayPlan` stays SNAPSHOT-only (acceptance 6), not preview.

**Tech Stack:** TypeScript, Vitest, node:sqlite, `@codebridge/workflow-engine` (`compileWorkflow`, `definitionHash`), `@codebridge/policy` (`FunctionCapabilityAdapter`), Hono session/flow APIs.

**Spec:** `docs/superpowers/specs/2026-08-19-flow-runtime-loop-design.md`  
**Branch:** `feat_flow` (from `origin/main`). Do not commit on `main`.

**Before editing any symbol:** `gitnexus_impact({target: "<symbol>", direction: "upstream", repo: "CodeBridge"})`. If risk is HIGH or CRITICAL, stop and warn. Before any commit: `gitnexus_detect_changes()`. If the GitNexus index is stale, run `npx gitnexus analyze` first.

**Order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 (4 can start after 3; 8 is the e2e that proves A).

---

## File map

| File | Responsibility |
| --- | --- |
| `apps/bridge/src/flow-compile.ts` | Lossless catalog → compile input; stable `planId`; hash check |
| `packages/flow-catalog/src/index.ts` | `FlowStep.successWhen` |
| `apps/bridge/src/flow-api.ts` | Persist `successWhen`; publish gates; review keeps content hash |
| `packages/policy/src/demo-capabilities.ts` | `demo.echo` / `demo.concat` adapters + register helper |
| `apps/bridge/src/cli.ts` | Boot-register demo capabilities |
| `packages/run-executor/src/index.ts` | No Agent fallback; `dry_run`; step outputs; VF truncate/category; SNAPSHOT; windowed idempotency; replay no-skip |
| `apps/bridge/src/session-runtime-api.ts` | Gates, hash check, `missing_inputs`, `inputs`/`dry_run` body, risk from plan |
| `apps/bridge/src/session-api.ts` | Delete implicit `adapter: "agent"`; use `flow-compile.ts` |
| `packages/work-items/src/index.ts` | Idempotency `created_at` read (window) |

Do not add a stored PlanIR blob as the load path. Do not call `replayPlan` from preview.

---

### Task 1: Lossless catalog compile helper + persist `successWhen`

**Files:**
- Create: `apps/bridge/src/flow-compile.ts`
- Create: `apps/bridge/src/flow-compile.test.ts`
- Modify: `packages/flow-catalog/src/index.ts` (`FlowStep`)
- Modify: `packages/flow-catalog/src/index.test.ts`

- [ ] **Step 1: Write the catalog persistence failing test**

Append to `packages/flow-catalog/src/index.test.ts`:

```ts
  it("persists successWhen on steps", () => {
    const store = new FlowCatalogStore(":memory:");
    const flow = store.save({
      flowId: "flow-pc",
      name: "PC",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: "sha256:def",
      planIrHash: "sha256:plan",
      inputs: [{ id: "text", type: "string", source: "user", required: true }],
      steps: [{
        id: "echo",
        capability: "demo.echo",
        mode: "read_only",
        successWhen: "output.text exists",
      }],
    });
    expect(store.get("flow-pc")?.steps[0]?.successWhen).toBe("output.text exists");
    expect(flow.steps[0]?.successWhen).toBe("output.text exists");
    store.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/flow-catalog/src/index.test.ts`
Expected: FAIL — `successWhen` is undefined (not on `FlowStep`, dropped by object spread of unknown fields? actually extra fields survive spread if passed in — TypeScript may strip at compile of the test if the interface forbids it. Add the field to the interface so the test compiles, then round-trip JSON already persists unknown keys. If the test passes only because JSON.stringify keeps the property without the type, still add the field explicitly.)

If the test already passes due to JSON round-trip of extra keys, keep the interface change anyway so callers type-check.

- [ ] **Step 3: Add `successWhen` to `FlowStep`**

In `packages/flow-catalog/src/index.ts`, add to `FlowStep`:

```ts
  successWhen?: string;
```

`save` already spreads `...step` into JSON. No schema migration.

- [ ] **Step 4: Write the compile-helper failing tests**

Create `apps/bridge/src/flow-compile.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { compileWorkflow, definitionHash } from "@codebridge/workflow-engine";
import {
  catalogPlanId,
  compileCatalogFlow,
  flowRecordToDefinition,
} from "./flow-compile.js";

describe("flow-compile", () => {
  it("recompiles stored steps to the same plan_ir_hash", () => {
    const definition = {
      schema_version: 1,
      workflow_id: "flow_demo_echo",
      name: "demo echo",
      kind: "runbook",
      status: "draft",
      inputs: [{ id: "text", type: "string", source: "user", required: true }],
      steps: [
        { id: "echo", capability: "demo.echo", mode: "read_only", success_when: "output.text exists" },
        {
          id: "concat",
          capability: "demo.concat",
          mode: "read_only",
          depends_on: ["echo"],
          success_when: "output.result exists",
        },
      ],
    };
    const plan = compileWorkflow(definition, {
      source: "workflow",
      definitionRevision: definitionHash(definition),
      planId: catalogPlanId("flow_demo_echo"),
    });
    const store = new FlowCatalogStore(":memory:");
    store.save({
      flowId: "flow_demo_echo",
      name: "demo echo",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: definitionHash(definition),
      planIrHash: definitionHash(plan),
      inputs: plan.inputs,
      steps: plan.steps.map((step) => ({
        id: step.id,
        capability: step.capabilityId ?? undefined,
        purpose: step.purpose ?? undefined,
        dependsOn: step.dependsOn,
        mode: step.risk,
        approval: step.approval,
        branches: step.branches,
        retry: step.retry ?? undefined,
        successWhen: step.successWhen ?? undefined,
      })),
    });
    const flow = store.get("flow_demo_echo")!;
    const again = compileCatalogFlow(flow);
    expect(definitionHash(again)).toBe(flow.planIrHash);
    expect(flowRecordToDefinition(flow).steps[0]).toMatchObject({
      success_when: "output.text exists",
    });
    store.close();
  });

  it("detects catalog step tampering against plan_ir_hash", () => {
    const store = new FlowCatalogStore(":memory:");
    const definition = {
      schema_version: 1,
      workflow_id: "flow_tamper",
      name: "t",
      kind: "runbook",
      status: "draft",
      inputs: [],
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only", success_when: "output.text exists" }],
    };
    const plan = compileWorkflow(definition, {
      source: "workflow",
      definitionRevision: definitionHash(definition),
      planId: catalogPlanId("flow_tamper"),
    });
    store.save({
      flowId: "flow_tamper",
      name: "t",
      kind: "runbook",
      status: "published",
      source: "user_selected",
      definitionRevision: definitionHash(definition),
      planIrHash: definitionHash(plan),
      inputs: plan.inputs,
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only", successWhen: "output.text exists" }],
    });
    const flow = store.get("flow_tamper")!;
    flow.steps[0]!.successWhen = "output.missing exists";
    expect(definitionHash(compileCatalogFlow(flow))).not.toBe(flow.planIrHash);
    store.close();
  });
});
```

- [ ] **Step 5: Run helper tests to verify they fail**

Run: `pnpm vitest run apps/bridge/src/flow-compile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement `flow-compile.ts`**

```ts
import type { FlowRecord } from "@codebridge/flow-catalog";
import { compileWorkflow, type PlanIR } from "@codebridge/workflow-engine";

export function catalogPlanId(flowId: string): string {
  return `plan_${flowId}`;
}

export function flowRecordToDefinition(flow: FlowRecord): Record<string, unknown> {
  return {
    schema_version: 1,
    workflow_id: flow.flowId,
    name: flow.name ?? flow.flowId,
    kind: flow.kind === "runbook" ? "runbook" : "guide",
    status: "draft",
    inputs: flow.inputs,
    steps: flow.steps.map((step) => ({
      id: step.id,
      capability: step.capability,
      purpose: step.purpose,
      depends_on: step.dependsOn ?? [],
      mode: step.mode,
      approval: step.approval ?? "none",
      branches: step.branches ?? [],
      retry: step.retry
        ? { max_attempts: step.retry.maxAttempts, delay_ms: step.retry.delayMs }
        : undefined,
      success_when: step.successWhen,
    })),
  };
}

export function compileCatalogFlow(flow: FlowRecord): PlanIR {
  return compileWorkflow(flowRecordToDefinition(flow), {
    source: flow.source === "agent_generated" ? "agent_generated" : "workflow",
    definitionRevision: flow.definitionRevision,
    planId: catalogPlanId(flow.flowId),
  });
}
```

`status` is always `"draft"` in the compile input so it matches `POST /v1/flows/candidates` (that handler already hardcodes `status: "draft"`). PlanIR hash does not include catalog `status`.

- [ ] **Step 7: Run both tests**

Run: `pnpm vitest run packages/flow-catalog/src/index.test.ts apps/bridge/src/flow-compile.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/flow-catalog/src/index.ts packages/flow-catalog/src/index.test.ts \
  apps/bridge/src/flow-compile.ts apps/bridge/src/flow-compile.test.ts
git commit -m "$(cat <<'EOF'
feat: persist successWhen and compile catalog flows losslessly

EOF
)"
```

---

### Task 2: Flow API — persist `successWhen`, keep content hash, publish gates

**Files:**
- Modify: `apps/bridge/src/flow-api.ts`
- Modify: `apps/bridge/src/flow-api.test.ts`
- Modify: `apps/bridge/src/cli.ts` (pass registry/runtime into `createFlowApp` — runtime wiring in Task 3; here add options types)

- [ ] **Step 1: Write failing tests**

Append to `apps/bridge/src/flow-api.test.ts` (keep existing candidate-hash test; add):

```ts
  it("persists success_when from the candidate body", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const app = createFlowApp(catalog, "token");
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "sess_1",
        flow: {
          flow_id: "flow-when",
          kind: "runbook",
          steps: [{
            id: "echo",
            capability: "demo.echo",
            mode: "read_only",
            success_when: "output.text exists",
          }],
        },
      }),
    });
    expect(response.status).toBe(201);
    expect(catalog.get("flow-when")?.steps[0]?.successWhen).toBe("output.text exists");
    const body = await response.json() as { steps: Array<{ success_when: string | null }> };
    expect(body.steps[0]?.success_when).toBe("output.text exists");
    catalog.close();
  });

  it("rejects publishing a runbook with a manual step", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    catalog.save({
      flowId: "flow-manual",
      name: "Manual",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [{ id: "ask", mode: "manual", purpose: "confirm" }],
    });
    const app = createFlowApp(catalog, "token");
    const approved = await app.request("/v1/flows/flow-manual/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(409);
    expect(await approved.json()).toMatchObject({ error: "flow_not_publishable" });
    expect(catalog.get("flow-manual")?.status).toBe("candidate");
    catalog.close();
  });
```

Change the existing test `"requires a Git revision before publishing a candidate"` assertion from `definition_revision: "git:abc123"` to `definition_revision: "sha256:one"` (same as the new test). Do not duplicate the whole test — edit that one expect.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/bridge/src/flow-api.test.ts`
Expected: FAIL — `successWhen` missing; approve still returns `git:abc123`.

- [ ] **Step 3: Implement**

In `apps/bridge/src/flow-api.ts` candidate `steps` map, include `successWhen: step.successWhen ?? undefined`.

In `toApiFlow`, include `plan_ir_hash: flow.planIrHash`, `inputs: flow.inputs`, and per-step `success_when: step.successWhen ?? null`.

On approve:

```ts
definitionRevision: flow.definitionRevision,
gitRevision: decision === "approve" ? String(body!.git_revision) : flow.gitRevision,
```

Do **not** set `definitionRevision` to `git:…`.

Add `publishIssues(flow, options): string[]`:

- if any step `mode === "manual"` → `"manual steps cannot be published"`
- if any step has no `capability` and has no `branches` → treat as manual, same issue
- for runbook: every non-branch step must have `options.capabilities?.get(id)` and `options.runtime?.has(definition.adapter)`; adapter kind must not be skill/`forwardToAgent`. If registry/runtime omitted, runbook approve returns `409 capability_registry_unavailable` except for guide.

For this task, if `options.capabilities` is missing, **runbook** approve is `409`; **guide** without manual still publishes (existing tests). Task 3 will pass registry+runtime from `cli.ts`.

Reject approve when `publishIssues` is non-empty: `409 { error: "flow_not_publishable", issues }`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/bridge/src/flow-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src/flow-api.ts apps/bridge/src/flow-api.test.ts
git commit -m "$(cat <<'EOF'
feat: keep flow content hashes and block unpublished manual runbooks

EOF
)"
```

---

### Task 3: Demo capabilities at Bridge boot

**Files:**
- Create: `packages/policy/src/demo-capabilities.ts`
- Create: `packages/policy/src/demo-capabilities.test.ts`
- Modify: `packages/policy/src/index.ts` (re-export)
- Modify: `apps/bridge/src/cli.ts` (register after `new CapabilityRuntime()`)
- Modify: `apps/bridge/src/flow-api.ts` / `cli.ts` to pass `capabilities` + `runtime` into `createFlowApp`

- [ ] **Step 1: Write failing tests**

Create `packages/policy/src/demo-capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CapabilityRegistry, CapabilityRuntime } from "./index.js";
import { registerDemoCapabilities } from "./demo-capabilities.js";

describe("demo capabilities", () => {
  it("echoes text and concats with the echo output", async () => {
    const registry = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    registerDemoCapabilities(registry, runtime);
    expect(registry.get("demo.echo")).toMatchObject({
      risk: "read_only", adapter: "demo.echo", side_effects: false, source: { version: "1" },
    });
    const echoed = await runtime.execute("demo.echo", {
      input: { text: "hi" },
      context: { dry_run: true },
    });
    expect(echoed.output).toEqual({ text: "hi" });
    const concated = await runtime.execute("demo.concat", {
      input: { text: "hi", step_outputs: { echo: { text: "hi" } } },
      context: {},
    });
    expect(concated.output).toEqual({ result: "hi" });
    registry.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/policy/src/demo-capabilities.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/policy/src/demo-capabilities.ts`:

```ts
import { CapabilityRegistry } from "./index.js";
import { CapabilityRuntime, FunctionCapabilityAdapter } from "./capability-runtime.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function registerDemoCapabilities(
  registry: CapabilityRegistry,
  runtime: CapabilityRuntime,
): void {
  const source = { kind: "function" as const, ref: "demo", version: "1" };
  registry.register({
    id: "demo.echo",
    risk: "read_only",
    adapter: "demo.echo",
    side_effects: false,
    description: "Echo input.text",
    source,
  });
  registry.register({
    id: "demo.concat",
    risk: "read_only",
    adapter: "demo.concat",
    side_effects: false,
    description: "Concat resolved text with prior echo output",
    source,
  });
  runtime.register(new FunctionCapabilityAdapter("demo.echo", ({ input }) => {
    const text = String(input.text ?? "");
    return { output: { text } };
  }));
  runtime.register(new FunctionCapabilityAdapter("demo.concat", ({ input }) => {
    const echo = asRecord(asRecord(input.step_outputs).echo);
    const text = String(echo.text ?? input.text ?? "");
    const prefix = String(input.prefix ?? "");
    return { output: { result: `${prefix}${text}` } };
  }));
}
```

Export from `packages/policy/src/index.ts`: `export { registerDemoCapabilities } from "./demo-capabilities.js";`

In `cli.ts`, after `const capabilityRuntime = new CapabilityRuntime();`:

```ts
registerDemoCapabilities(capabilityRegistry, capabilityRuntime);
```

Pass into `createFlowApp(..., { sessions, events, capabilities: capabilityRegistry, runtime: capabilityRuntime })`.

Add a runbook-publish **success** test in `flow-api.test.ts` that registers demo capabilities then approves a two-step `demo.*` candidate with `success_when`. Expect 200.

Add a runbook-publish **failure** test: runbook step `equity.deliver` with empty registry → 409 `flow_not_publishable`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/policy/src/demo-capabilities.test.ts apps/bridge/src/flow-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/policy/src/demo-capabilities.ts packages/policy/src/demo-capabilities.test.ts \
  packages/policy/src/index.ts apps/bridge/src/cli.ts apps/bridge/src/flow-api.ts apps/bridge/src/flow-api.test.ts
git commit -m "$(cat <<'EOF'
feat: register demo.echo and demo.concat at Bridge boot

EOF
)"
```

---

### Task 4: RunExecutor — runbook steps never call Runner

**Files:**
- Modify: `packages/run-executor/src/index.ts` (`executeStepOnce`, `executeCapability`, `replayPlan`)
- Modify: `packages/run-executor/src/index.test.ts`

Ground truth today: `executeStepOnce` ~707–770; `executeCapability` ~919–957 omits `dry_run`; `replayPlan` ~149–155 `continue`s on missing adapter.

- [ ] **Step 1: Write failing tests**

Append to `packages/run-executor/src/index.test.ts`:

```ts
  it("fails a plan step when the capability adapter is missing instead of calling the runner", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "t", mode: "auto", conversationId: "c", riskLevel: "read_only",
    });
    const plan = store.savePlan({
      planId: "plan_missing", source: "workflow", workflowId: "flow_1",
      definitionRevision: "sha256:def", planIrHash: "sha256:plan",
      steps: [{
        id: "echo", capabilityId: "demo.echo", risk: "read_only",
        dependsOn: [], guard: null, approval: "none", branches: [], purpose: null,
      }],
    });
    const run = store.createRun({
      workItemId: item.id, mode: "auto", planId: plan.planId, planIrHash: "sha256:plan",
    });
    const runner = new FakeRunner([{ type: "done", exitCode: 0 }]);
    const registry = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    const executor = new RunExecutor(store, runner, {
      policy: new PolicyEngine(registry),
      capabilities: runtime,
      resolveRequest: (_w, current) => ({
        runId: current.id, sessionKey: { chatId: "c", backendId: "pi", cwd: "/tmp" }, prompt: "nope",
      }),
    });
    await expect(executor.execute(run.id)).rejects.toThrow(/unknown_capability/);
    expect(runner.requests).toHaveLength(0);
    registry.close();
    store.close();
  });

  it("passes dry_run into executeCapability and does not skip missing adapters during preview", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "t", mode: "auto", conversationId: "c", riskLevel: "read_only",
      identifiers: { text: "hi" },
    });
    const plan = store.savePlan({
      planId: "plan_dry", source: "workflow", workflowId: "flow_1",
      definitionRevision: "sha256:def",
      steps: [{
        id: "echo", capabilityId: "demo.echo", risk: "read_only",
        dependsOn: [], guard: null, approval: "none", branches: [], purpose: null,
        successWhen: "output.text exists",
      }],
    });
    const seen: Array<boolean | undefined> = [];
    const registry = new CapabilityRegistry([{
      id: "demo.echo", risk: "read_only", adapter: "demo.echo", side_effects: false,
    }]);
    const runtime = new CapabilityRuntime([
      new FunctionCapabilityAdapter("demo.echo", ({ input, context }) => {
        seen.push(context.dry_run);
        return { output: { text: input.text } };
      }),
    ]);
    const run = store.createRun({ workItemId: item.id, mode: "auto", planId: plan.planId });
    const executor = new RunExecutor(store, new FakeRunner([]), {
      policy: new PolicyEngine(registry),
      capabilities: runtime,
      dryRun: true,
      resolveRequest: (_w, current) => ({
        runId: current.id, sessionKey: { chatId: "c", backendId: "pi", cwd: "/tmp" }, prompt: "x",
      }),
    });
    await executor.execute(run.id);
    expect(seen).toEqual([true]);
    registry.close();
    store.close();
  });
```

Add `dryRun?: boolean` on `RunExecutor` options (constructor). Preview is the same `execute()` with this flag — **not** `replayPlan`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/run-executor/src/index.test.ts`
Expected: FAIL — missing adapter still hits FakeRunner; `dry_run` undefined.

- [ ] **Step 3: Implement `executeStepOnce` / `executeCapability`**

Replace the fall-through in `executeStepOnce`:

After `executeCapability`:

- If `step?.capabilityId` is set:
  - If result is missing or `forwardToAgent` → throw `Error("unknown_capability")` (or `CapabilityExecutionError` with `retryable: false`). Do **not** call `runner.run`.
  - Evaluate `successWhen` as today.
  - `return` (do not reach `resolveRequest`).
- If `step` is null (unbound / no plan): existing `runner.run` path unchanged.

In `executeCapability`:

- If `!definition` or `!this.options.capabilities.has(definition.adapter)` → throw, do not `return undefined`.
- Pass `dry_run: this.options.dryRun === true` (or per-execute flag stored on the instance for that call) in `context`.
- Pass capability input:

```ts
input: {
  ...this.resolvedValues(workItem),
  step_outputs: this.stepOutputs.get(run.id) ?? {},
  step: { id: step.id, purpose: step.purpose },
},
```

Accumulate `this.stepOutputs` (a `Map<runId, Record<string, unknown>>`) with `result.output` keyed by `step.id` after success. Clear on `succeed`/`fail`/`finally`.

`resolvedValues(workItem)`: `workItem.identifiers` for this task; Task 6 will fill identifiers from request `inputs`.

Add `dryRun?: boolean` to the executor options type next to `policy`.

- [ ] **Step 4: Fix tests that relied on Agent fallback**

Any existing executor test that runs a plan step without an adapter will now reject. Update those fixtures to either omit `planId` (unbound Agent) or register a function adapter. Do **not** restore fallback.

The implicit-register test lives in `session-api.test.ts` (Task 7).

- [ ] **Step 5: Run executor tests**

Run: `pnpm vitest run packages/run-executor/src/index.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/run-executor/src/index.ts packages/run-executor/src/index.test.ts
git commit -m "$(cat <<'EOF'
fix: fail runbook steps without adapters instead of calling the runner

EOF
)"
```

---

### Task 5: Session runtime gates — hash, lifecycle, missing inputs, dry_run

**Files:**
- Modify: `apps/bridge/src/session-runtime-api.ts`
- Modify: `apps/bridge/src/session-runtime-api.test.ts`
- Delete uses of `flowDefinition()` (replace with `compileCatalogFlow`)

- [ ] **Step 1: Write failing tests**

Extend `apps/bridge/src/session-runtime-api.test.ts` `setup()` to accept optional `{ flows, executor, capabilities }`.

```ts
  it("rejects candidate runbook execution without dry_run", async () => {
    const flows = new FlowCatalogStore(":memory:");
    flows.save({
      flowId: "flow_demo_echo",
      name: "demo",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: "sha256:def",
      planIrHash: "sha256:plan",
      inputs: [{ id: "text", type: "string", source: "user", required: true }],
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only", successWhen: "output.text exists" }],
    });
    const fixture = setup({ flows });
    fixture.catalog.updateSession(fixture.session.id, { flowId: "flow_demo_echo" });
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "k1",
        },
        body: JSON.stringify({ message: "run", inputs: { text: "hi" } }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "flow_not_executable" });
    flows.close();
  });

  it("returns missing_inputs without creating a run", async () => {
    const flows = new FlowCatalogStore(":memory:");
    const definition = {
      schema_version: 1,
      workflow_id: "flow_demo_echo",
      name: "demo",
      kind: "runbook",
      status: "draft",
      inputs: [{ id: "text", type: "string", source: "user", required: true }],
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only", success_when: "output.text exists" }],
    };
    const plan = compileWorkflow(definition, {
      source: "workflow",
      definitionRevision: definitionHash(definition),
      planId: catalogPlanId("flow_demo_echo"),
    });
    flows.save({
      flowId: "flow_demo_echo",
      name: "demo",
      kind: "runbook",
      status: "published",
      source: "user_selected",
      definitionRevision: definitionHash(definition),
      planIrHash: definitionHash(plan),
      inputs: plan.inputs,
      steps: [{
        id: "echo",
        capability: "demo.echo",
        mode: "read_only",
        successWhen: "output.text exists",
      }],
    });
    const fixture = setup({ flows });
    fixture.catalog.updateSession(fixture.session.id, { flowId: "flow_demo_echo" });
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "k2",
        },
        body: JSON.stringify({ message: "run" }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "missing_inputs" });
    expect(fixture.workItems.getSessionRuntime(fixture.session.id)?.activeRunId ?? null).toBeNull();
    expect(fixture.catalog.getSession(fixture.session.id)?.taskRecordId ?? null).toBeNull();
    flows.close();
  });
```

For `missing_inputs`, assert `fixture.workItems` has **no** new run for that session (use `listRuns` on the work item after submit, or query coordinator runtime `activeRunId` is null). Wire the test with a real `planIrHash` from `compileCatalogFlow` so the request fails on missing inputs, not drift.

Add a third test: mutate `successWhen` on a published flow without changing `planIrHash` → `409 { error: "plan_ir_drift" }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/bridge/src/session-runtime-api.test.ts`
Expected: FAIL — candidate currently compiles and 202s; missing `text` still 202s.

- [ ] **Step 3: Implement message handler**

Replace `flowDefinition` + `compileWorkflow` with:

```ts
import { compileCatalogFlow } from "./flow-compile.js";
import { definitionHash } from "@codebridge/workflow-engine";
```

After loading `flow`:

1. `deprecated` → 409 `flow_deprecated` (already).
2. `kind === "runbook"` and `status === "candidate"` and `body.dry_run !== true` → 409 `flow_not_executable`.
3. `kind === "runbook"` and `status === "published"` and `body.dry_run === true` → allowed (preview of published is fine).
4. `compileCatalogFlow(flow)` then `definitionHash(plan) !== flow.planIrHash` → 409 `plan_ir_drift`.
5. Required inputs: `flow.inputs.filter(i => i.required && i.source === "user")`. Values from `body.inputs` (must be a record) else empty. Missing → 409 `{ error: "missing_inputs", missing: [{ id, type, source, reason: "required" }] }`. **Do not** call `submitTurn`.
6. Pass compiled plan into `submitTurn` as today (`planIrHash: flow.planIrHash`).
7. `workItem.riskLevel`: max of plan step risks (`read_only < workspace_write < git_write < production_write`). Never hardcode `"read_only"` when a plan exists.
8. Thread `dry_run` onto the run the executor can see: set `options.executor` dry-run for that execute, e.g. `observeExecution` calls `executor.execute(runId, { dryRun: body.dry_run === true })` — add an argument/options bag on `execute` rather than a process-global flag.

Delete `flowDefinition()`.

Guide: if `kind !== "runbook"`, do not compile as executable plan (leave `frozenPlan` null) so unbound-style Agent path remains. Spec: guide is pointer + Agent.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/bridge/src/session-runtime-api.test.ts`
Expected: PASS (existing unbound message test still 202)

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src/session-runtime-api.ts apps/bridge/src/session-runtime-api.test.ts
git commit -m "$(cat <<'EOF'
feat: gate runbook turns on publish state, inputs, and plan hash

EOF
)"
```

---

### Task 6: `PARAM_RESOLVED` + fill identifiers from `inputs`

**Files:**
- Modify: `apps/bridge/src/session-runtime-api.ts` (after missing-input check, before `submitTurn`)
- Modify: `apps/bridge/src/session-runtime-api.test.ts`

- [ ] **Step 1: Write failing test**

Published `flow_demo_echo` with matching hash. POST message with `inputs: { text: "hi" }`. After 202 (and executor run in Task 8; for this task, asserting events on the work item after `submitTurn` is enough if executor is absent — append events in the API **before** dispatch):

```ts
expect(fixture.workItems.listEvents(workItemId).some((event) => event.type === "PARAM_RESOLVED")).toBe(true);
expect(fixture.workItems.getWorkItem(workItemId)?.identifiers).toMatchObject({ text: "hi" });
```

Payload must include `field: "text"`, `final_value: "hi"`, `resolution: "confirmed"`, `source: "user"`, `flow_revision: flow.planIrHash`, `resolver_version: "v1"`.

Second request same session with `inputs: { text: "yo" }` after a default/candidate of `"hi"` → `resolution: "edited"`. For v1, if `body.inputs.text !== flow.inputs[].default` and a previous PARAM_RESOLVED exists, mark `edited`; else `confirmed`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/bridge/src/session-runtime-api.test.ts`
Expected: FAIL — no `PARAM_RESOLVED`.

- [ ] **Step 3: Implement**

After validating inputs, `workItems.appendEvent` one `PARAM_RESOLVED` per field. Set `identifiers` on createWorkItem path (`submitTurn` `workItem` bag): `identifiers: body.inputs`.

Never write `agent_extracted` finals in this task.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/bridge/src/session-runtime-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src/session-runtime-api.ts apps/bridge/src/session-runtime-api.test.ts
git commit -m "$(cat <<'EOF'
feat: record PARAM_RESOLVED from explicit runbook inputs

EOF
)"
```

---

### Task 7: `VERIFICATION_FAILED` four-category + 4KB truncate; `RUN_SNAPSHOT`; windowed idempotency; honest `replayPlan`

**Files:**
- Modify: `packages/run-executor/src/index.ts`
- Modify: `packages/run-executor/src/index.test.ts`
- Modify: `packages/work-items/src/index.ts` (`getIdempotencyResponse` return `created_at`)

- [ ] **Step 1: Write failing tests**

1. Postcondition fail with `actual` a 5KB string → event payload `truncated: true` and serialized `actual` ≤ 4096 bytes.
2. Missing adapter throw → `VERIFICATION_FAILED` `category: "policy"` (or keep the throw and also append the event before rethrow). Spec: policy = 越权/未审批/未知能力.
3. Adapter throw `CapabilityExecutionError({ retryable: true })` after retries exhausted → `category: "infrastructure"`.
4. Successful demo-style run appends `RUN_SNAPSHOT` with `output_ref` matching `^artifact://`, `attribution.flow_revision === plan.planIrHash`, placeholder prompt/tool hashes documented as sha256 of `codebridge:unbound-prompt` and `codebridge:unbound-tools`.
5. Idempotency `validity_window: "24h"`: freeze time — store `created_at` 25h ago (insert row then; or add a test-only clock). Second execute must invoke adapter again. Existing permanent/within-window test still one invocation.
6. `replayPlan` on a plan whose capability is unregistered **throws** `unknown_capability` (no `continue`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/run-executor/src/index.test.ts packages/work-items/src/index.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Helper in `run-executor`:

```ts
const ACTUAL_LIMIT = 4096;
function capActual(value: unknown): { actual: unknown; truncated: boolean } {
  const json = JSON.stringify(value) ?? "null";
  if (Buffer.byteLength(json, "utf8") <= ACTUAL_LIMIT) return { actual: value, truncated: false };
  return { actual: json.slice(0, ACTUAL_LIMIT), truncated: true };
}
```

On postcondition fail, set `category: "verification"` and `capActual(output)`.

On capability miss: `category: "policy"`.

On retryable adapter errors: `category: "infrastructure"`.

`llm_output` is unused on this path this round (no LLM step); do not fake it.

On `succeed` / `fail` of a run that `runHasIr`, append `RUN_SNAPSHOT`. Create one artifact per step output (`createArtifact`) and set `output_ref: artifact://${id}`.

`idempotencyKey` still hashes flow+step+field values, but read values from `workItem.identifiers` (now real inputs). `getIdempotencyResponse` should also return `created_at`. If `validity_window === "24h"` and age > 24h, ignore the row (same for `7d`). `permanent` never expires. Missing window → treat as `permanent` (current behavior) so old manifests do not suddenly re-fire.

`replayPlan`: replace `continue` with `throw new Error("unknown_capability")`. Keep `context.dry_run: true`. Do not use it from session APIs.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/run-executor/src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/run-executor/src/index.ts packages/run-executor/src/index.test.ts packages/work-items/src/index.ts
git commit -m "$(cat <<'EOF'
feat: emit run snapshots and fail closed on replay gaps

EOF
)"
```

---

### Task 8: Remove implicit `adapter: "agent"` + e2e main path

**Files:**
- Modify: `apps/bridge/src/session-api.ts` (delete `capabilities.register({ adapter: "agent" })` ~810–818; replace `toWorkflowDefinition` with `compileCatalogFlow`)
- Modify: `apps/bridge/src/session-api.test.ts` (the compile-plan test must not expect implicit agent adapters)
- Modify: `apps/bridge/src/session-runtime-api.test.ts` (full loop with executor)

- [ ] **Step 1: Write the e2e failing test**

In `session-runtime-api.test.ts`, build registry+runtime via `registerDemoCapabilities`, construct `RunExecutor` with `FakeRunner` (must receive **zero** requests), pass `executor` into `createSessionApp`.

Save published `flow_demo_echo` using the Task 1 round-trip (real hashes). POST `/messages` with `Idempotency-Key`, `inputs: { text: "hi" }`, `flow_id`. `observeExecution` already calls `executor.execute`.

Assert:

- 202
- `runner.requests.length === 0`
- events include `PARAM_RESOLVED` and `RUN_SNAPSHOT`
- run status `succeeded`

Second case: omit `text` → 409 `missing_inputs`, runner still 0, no run.

Third: unbound session (no `flow_id`) POST `"hello"` → FakeRunner **is** called (regression).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/bridge/src/session-runtime-api.test.ts apps/bridge/src/session-api.test.ts`
Expected: FAIL until executor is wired in `setup` and implicit register is gone.

- [ ] **Step 3: Implement**

Delete implicit register. Update `"compiles the selected Workflow revision into a persisted Run Plan"`: register `demo.*` or drop the `adapter: "agent"` expects; use `compileCatalogFlow` so `inputs`/`successWhen` survive. If that test still uses `context.inspect` without adapters, either change the flow to `demo.echo` or expect 409 from executor — **do not** re-add agent register.

Ensure `observeExecution` uses the same executor instance as the test.

- [ ] **Step 4: Run the focused + related suites**

Run:

```bash
pnpm vitest run \
  packages/flow-catalog/src/index.test.ts \
  packages/policy/src/demo-capabilities.test.ts \
  packages/run-executor/src/index.test.ts \
  apps/bridge/src/flow-api.test.ts \
  apps/bridge/src/flow-compile.test.ts \
  apps/bridge/src/session-runtime-api.test.ts \
  apps/bridge/src/session-api.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src/session-api.ts apps/bridge/src/session-api.test.ts \
  apps/bridge/src/session-runtime-api.ts apps/bridge/src/session-runtime-api.test.ts
git commit -m "$(cat <<'EOF'
feat: run published demo runbooks on the session message path

EOF
)"
```

---

## Spec coverage

| Spec | Task |
| --- | --- |
| A: Runtime executes bound runbook | 4, 8 |
| §4.1 Agent demotion / no fallback | 4, 8 |
| §4.2 no manual/skill publish; demo.* boot | 2, 3 |
| §4.3 `missing_inputs` | 5 |
| §5 recompile + hash; no stored-IR load | 1, 5 |
| §5 dry-run = `executeCapability` + `dry_run` | 4, 5 |
| `replayPlan` only acceptance 6 | 7 |
| `PARAM_RESOLVED` | 6 |
| `RUN_SNAPSHOT` + VF truncate/categories | 7 |
| `validity_window` | 7 |
| Acceptance 9 unbound Agent | 8 |
| Review does not overwrite content hash | 2 |
| Delete `toWorkflowDefinition` / `flowDefinition` | 5, 8 |

## Self-review

- No TBD: demo adapters, helper, gates, executor fall-through, events, e2e are specified with code.
- `dryRun` on `execute` is the preview flag; `replayPlan` is not called from APIs.
- Guide is not compiled into an executable plan on the message path.
- Local MCP sqlite is not used for CI.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-08-19-flow-runtime-loop.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks
2. **Inline Execution** — this session, `executing-plans`, batch with checkpoints

Which approach?
