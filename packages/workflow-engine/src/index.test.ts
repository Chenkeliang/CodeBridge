import { describe, expect, it } from "vitest";
import {
  WorkflowValidationError,
  compileWorkflow,
  definitionHash,
  parseWorkflow,
  promptHash,
} from "./index.js";

const workflow = {
  schema_version: 1,
  workflow_id: "price-change",
  name: "价格调整检查与执行",
  kind: "runbook",
  status: "published",
  inputs: ["sku"],
  steps: [
    {
      id: "resolve_sku",
      capability: "datamaster.lookup",
      mode: "read_only",
    },
    {
      id: "inspect_rule",
      capability: "price_rule.query",
      mode: "read_only",
      depends_on: ["resolve_sku"],
    },
    {
      id: "choose_path",
      branches: [
        { when: "rule_exists == true", next: "update_rule" },
        { when: "otherwise", next: "manual_review" },
      ],
      depends_on: ["inspect_rule"],
    },
    {
      id: "update_rule",
      capability: "price_rule.update",
      mode: "production_write",
      approval: "required",
    },
    {
      id: "manual_review",
      mode: "manual",
      purpose: "等待用户补充事实",
    },
  ],
};

describe("workflow-engine", () => {
  it("parses and compiles a workflow into Plan IR", () => {
    const definition = parseWorkflow(JSON.stringify(workflow));
    const plan = compileWorkflow(definition, {
      definitionRevision: "git:abc123",
    });

    expect(plan).toMatchObject({
      source: "workflow",
      workflowId: "price-change",
      definitionRevision: "git:abc123",
    });
    expect(plan.planId).toMatch(/^plan_/);
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "inspect_rule",
          capabilityId: "price_rule.query",
          dependsOn: ["resolve_sku"],
          risk: "read_only",
        }),
        expect.objectContaining({
          id: "choose_path",
          branches: [
            { when: "rule_exists == true", next: "update_rule" },
            { when: "otherwise", next: "manual_review" },
          ],
        }),
      ]),
    );
  });

  it("rejects an unresolved branch and unapproved production write", () => {
    const invalid = {
      ...workflow,
      steps: [
        {
          id: "release",
          capability: "release.execute",
          mode: "production_write",
        },
        {
          id: "branch",
          branches: [{ when: "ready", next: "missing" }],
        },
      ],
    };

    expect(() => compileWorkflow(invalid)).toThrow(WorkflowValidationError);
    try {
      compileWorkflow(invalid);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      expect((error as WorkflowValidationError).issues).toEqual(
        expect.arrayContaining([
          "step release: production_write requires approval: required",
          "step branch: branch target does not exist: missing",
        ]),
      );
    }
  });

  it("rejects dependency cycles", () => {
    const cyclic = {
      ...workflow,
      steps: [
        {
          id: "a",
          capability: "a.read",
          mode: "read_only",
          depends_on: ["b"],
        },
        {
          id: "b",
          capability: "b.read",
          mode: "read_only",
          depends_on: ["a"],
        },
      ],
    };

    expect(() => compileWorkflow(cyclic)).toThrow(
      "workflow contains a dependency cycle",
    );
  });

  it("compiles an explicit bounded retry policy", () => {
    const retrying = {
      ...workflow,
      steps: [{
        id: "inspect",
        capability: "service.inspect",
        mode: "read_only",
        retry: { max_attempts: 3, delay_ms: 25 },
      }],
    };
    expect(compileWorkflow(retrying).steps[0]?.retry).toEqual({ maxAttempts: 3, delayMs: 25 });
    expect(() => compileWorkflow({
      ...retrying,
      steps: [{ ...retrying.steps[0], retry: { max_attempts: 0 } }],
    })).toThrow("step[0].retry.max_attempts must be an integer between 1 and 10");
  });
});

describe("contract content hashing", () => {
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
});

describe("typed inputs", () => {
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
});
