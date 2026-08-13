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
