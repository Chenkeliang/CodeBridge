import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SkillControlPlane,
} from "./skill-control-plane.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-skills-"));
  temporaryDirectories.push(root);
  return root;
}

function createSkill(root: string, name: string, description = `${name} description`): string {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
  return directory;
}

function createControlPlane(root: string) {
  const home = path.join(root, "home");
  const dataDir = path.join(root, "data");
  const sharedRoot = path.join(home, ".agents", "skills");
  const disabledRoot = path.join(home, ".agents", "skills-disabled");
  const targetRoots = {
    codex: path.join(home, ".codex", "skills"),
    claude: path.join(home, ".claude", "skills"),
    cursor: path.join(home, ".cursor", "skills"),
    opencode: path.join(home, ".config", "opencode", "skills"),
    pi: path.join(home, ".pi", "agent", "skills"),
  } as const;
  fs.mkdirSync(sharedRoot, { recursive: true });
  fs.mkdirSync(disabledRoot, { recursive: true });
  return {
    home,
    dataDir,
    sharedRoot,
    disabledRoot,
    targetRoots,
    service: new SkillControlPlane({
      dataDir,
      homeDirectory: home,
      sharedRoot,
      disabledRoot,
      targetRoots,
    }),
  };
}

describe("SkillControlPlane catalog", () => {
  it("scans shared, adopted, and Agent-native sources with stable metadata", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    const shared = createSkill(fixture.sharedRoot, "database-query", "Query approved databases");
    const adoptedCollection = path.join(root, "adopted");
    const adopted = createSkill(adoptedCollection, "frontend-design");
    const native = createSkill(fixture.targetRoots.cursor, "cursor-only");

    fixture.service.addSource(adoptedCollection);
    const snapshot = fixture.service.scan();

    expect(snapshot.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "database-query",
        description: "Query approved databases",
        source_path: fs.realpathSync(shared),
        source_kind: "shared",
      }),
      expect.objectContaining({
        name: "frontend-design",
        source_path: fs.realpathSync(adopted),
        source_kind: "adopted",
      }),
      expect.objectContaining({
        name: "cursor-only",
        source_path: fs.realpathSync(native),
        source_kind: "agent_native",
        targets: expect.arrayContaining([
          expect.objectContaining({ agent_id: "cursor", state: "follows_global" }),
        ]),
      }),
    ]));
    expect(snapshot.summary.total).toBe(3);
    expect(snapshot.targets).toHaveLength(5);
    expect(snapshot.skills.every((skill) => skill.id === path.basename(skill.source_path))).toBe(true);
    expect(snapshot.skills.every((skill) => /^[a-f0-9]{64}$/.test(skill.revision))).toBe(true);
  });

  it("deduplicates a Skill reached through multiple roots by real path", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    const source = createSkill(fixture.sharedRoot, "shared-skill");
    fs.mkdirSync(fixture.targetRoots.claude, { recursive: true });
    fs.symlinkSync(source, path.join(fixture.targetRoots.claude, "shared-skill"), "dir");

    const snapshot = fixture.service.scan();

    expect(snapshot.skills.filter((skill) => skill.name === "shared-skill")).toHaveLength(1);
    expect(snapshot.skills[0]?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: "claude", state: "linked" }),
    ]));
  });

  it("rejects an adopted path without a Skill package", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);

    expect(() => fixture.service.addSource(empty)).toThrowError(
      expect.objectContaining({ code: "skill_source_invalid" }),
    );
  });
});

describe("SkillControlPlane mutations", () => {
  it("adopts an existing shared Skill in place before allowing writes", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    createSkill(fixture.sharedRoot, "database-query");

    const plan = fixture.service.previewAdopt({ skill_id: "database-query", actor_id: "local" });
    expect(plan).toMatchObject({ kind: "adopt", can_apply: true });
    fixture.service.applyPlan({ plan_id: plan.plan_id, actor_id: "local" });

    expect(fixture.service.scan().skills[0]).toMatchObject({
      id: "database-query",
      ownership: "codebridge_managed",
      global_state: "enabled",
    });
  });

  it("creates and removes only the Claude projection through preview-bound plans", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    createSkill(fixture.sharedRoot, "database-query");
    const adopt = fixture.service.previewAdopt({ skill_id: "database-query", actor_id: "local" });
    fixture.service.applyPlan({ plan_id: adopt.plan_id, actor_id: "local" });

    const enable = fixture.service.previewAssignment({
      skill_id: "database-query",
      agent_id: "claude",
      enabled: true,
      actor_id: "local",
    });
    fixture.service.applyPlan({ plan_id: enable.plan_id, actor_id: "local" });
    expect(fs.realpathSync(path.join(fixture.targetRoots.claude, "database-query")))
      .toBe(fs.realpathSync(path.join(fixture.sharedRoot, "database-query")));

    const disable = fixture.service.previewAssignment({
      skill_id: "database-query",
      agent_id: "claude",
      enabled: false,
      actor_id: "local",
    });
    fixture.service.applyPlan({ plan_id: disable.plan_id, actor_id: "local" });
    expect(fs.existsSync(path.join(fixture.targetRoots.claude, "database-query"))).toBe(false);
  });

  it("moves a managed package between active and disabled roots and restores desired links", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    createSkill(fixture.sharedRoot, "database-query");
    const adopt = fixture.service.previewAdopt({ skill_id: "database-query", actor_id: "local" });
    fixture.service.applyPlan({ plan_id: adopt.plan_id, actor_id: "local" });
    const assignment = fixture.service.previewAssignment({
      skill_id: "database-query", agent_id: "claude", enabled: true, actor_id: "local",
    });
    fixture.service.applyPlan({ plan_id: assignment.plan_id, actor_id: "local" });

    const suspend = fixture.service.previewGlobalState({
      skill_id: "database-query", enabled: false, actor_id: "local",
    });
    fixture.service.applyPlan({ plan_id: suspend.plan_id, actor_id: "local" });
    expect(fs.existsSync(path.join(fixture.disabledRoot, "database-query", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.targetRoots.claude, "database-query"))).toBe(false);

    const resume = fixture.service.previewGlobalState({
      skill_id: "database-query", enabled: true, actor_id: "local",
    });
    fixture.service.applyPlan({ plan_id: resume.plan_id, actor_id: "local" });
    expect(fs.existsSync(path.join(fixture.sharedRoot, "database-query", "SKILL.md"))).toBe(true);
    expect(fs.realpathSync(path.join(fixture.targetRoots.claude, "database-query")))
      .toBe(fs.realpathSync(path.join(fixture.sharedRoot, "database-query")));
  });

  it("rejects a plan after actor, package, or target facts change", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    const directory = createSkill(fixture.sharedRoot, "database-query");
    const adopt = fixture.service.previewAdopt({ skill_id: "database-query", actor_id: "local" });
    expect(() => fixture.service.applyPlan({ plan_id: adopt.plan_id, actor_id: "other" }))
      .toThrowError(expect.objectContaining({ code: "skill_plan_actor_mismatch" }));

    fs.writeFileSync(path.join(directory, "SKILL.md"), "---\nname: database-query\n---\nchanged\n");
    expect(() => fixture.service.applyPlan({ plan_id: adopt.plan_id, actor_id: "local" }))
      .toThrowError(expect.objectContaining({ code: "skill_revision_mismatch" }));
  });

  it("rejects expired plans and target drift", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    createSkill(fixture.sharedRoot, "database-query");
    const adopt = fixture.service.previewAdopt({ skill_id: "database-query", actor_id: "local" });
    const plansPath = path.join(fixture.dataDir, "state", "skills", "plans.json");
    const plans = JSON.parse(fs.readFileSync(plansPath, "utf8")) as Record<string, { expires_at: string }>;
    plans[adopt.plan_id]!.expires_at = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(plansPath, JSON.stringify(plans), "utf8");
    expect(() => fixture.service.applyPlan({ plan_id: adopt.plan_id, actor_id: "local" }))
      .toThrowError(expect.objectContaining({ code: "skill_plan_expired" }));

    const fresh = fixture.service.previewAdopt({ skill_id: "database-query", actor_id: "local" });
    fixture.service.applyPlan({ plan_id: fresh.plan_id, actor_id: "local" });
    const assignment = fixture.service.previewAssignment({
      skill_id: "database-query", agent_id: "claude", enabled: true, actor_id: "local",
    });
    fs.mkdirSync(path.join(fixture.targetRoots.claude, "database-query"), { recursive: true });
    expect(() => fixture.service.applyPlan({ plan_id: assignment.plan_id, actor_id: "local" }))
      .toThrowError(expect.objectContaining({ code: "skill_target_conflict" }));
  });

  it("persists ownership across restart and unmanages without removing content or links", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    createSkill(fixture.sharedRoot, "database-query");
    const adopt = fixture.service.previewAdopt({ skill_id: "database-query", actor_id: "local" });
    fixture.service.applyPlan({ plan_id: adopt.plan_id, actor_id: "local" });
    const assignment = fixture.service.previewAssignment({
      skill_id: "database-query", agent_id: "claude", enabled: true, actor_id: "local",
    });
    fixture.service.applyPlan({ plan_id: assignment.plan_id, actor_id: "local" });

    const restarted = new SkillControlPlane({
      dataDir: fixture.dataDir,
      homeDirectory: fixture.home,
      sharedRoot: fixture.sharedRoot,
      disabledRoot: fixture.disabledRoot,
      targetRoots: fixture.targetRoots,
    });
    expect(restarted.scan().skills[0]!.ownership).toBe("codebridge_managed");
    const unmanage = restarted.previewUnmanage({ skill_id: "database-query", actor_id: "local" });
    restarted.applyPlan({ plan_id: unmanage.plan_id, actor_id: "local" });

    expect(restarted.scan().skills[0]!.ownership).toBe("external_observed");
    expect(fs.existsSync(path.join(fixture.sharedRoot, "database-query", "SKILL.md"))).toBe(true);
    expect(fs.lstatSync(path.join(fixture.targetRoots.claude, "database-query")).isSymbolicLink()).toBe(true);
  });

  it("does not unlink a foreign target when ownership state is absent", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    const source = createSkill(fixture.sharedRoot, "database-query");
    fs.mkdirSync(fixture.targetRoots.claude, { recursive: true });
    fs.symlinkSync(source, path.join(fixture.targetRoots.claude, "database-query"), "dir");

    expect(() => fixture.service.previewAssignment({
      skill_id: "database-query", agent_id: "claude", enabled: false, actor_id: "local",
    })).toThrowError(expect.objectContaining({ code: "skill_unlink_forbidden" }));
    expect(fs.lstatSync(path.join(fixture.targetRoots.claude, "database-query")).isSymbolicLink()).toBe(true);
  });

  it("adopts an external Claude package by moving it to shared and linking back", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    createSkill(fixture.targetRoots.claude, "database-query");

    const plan = fixture.service.previewAdopt({ skill_id: "database-query", actor_id: "local" });
    fixture.service.applyPlan({ plan_id: plan.plan_id, actor_id: "local" });

    expect(fs.existsSync(path.join(fixture.sharedRoot, "database-query", "SKILL.md"))).toBe(true);
    expect(fs.lstatSync(path.join(fixture.targetRoots.claude, "database-query")).isSymbolicLink()).toBe(true);
    expect(fixture.service.scan().skills[0]).toMatchObject({
      global_state: "enabled",
      ownership: "codebridge_managed",
    });
  });

  it("recovers a persisted Adopt transaction after the source move", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    const source = createSkill(fixture.targetRoots.claude, "database-query");
    const plan = fixture.service.previewAdopt({ skill_id: "database-query", actor_id: "local" });
    const transactionId = "tx-recovery";
    const transactionsPath = path.join(fixture.dataDir, "state", "skills", "transactions.json");
    fs.mkdirSync(path.dirname(transactionsPath), { recursive: true });
    fs.writeFileSync(transactionsPath, JSON.stringify({
      [transactionId]: {
        transaction_id: transactionId,
        plan_id: plan.plan_id,
        kind: "adopt",
        status: "pending",
        stage: "source_switched",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    }), "utf8");
    fs.renameSync(source, path.join(fixture.sharedRoot, "database-query"));

    const restarted = new SkillControlPlane({
      dataDir: fixture.dataDir,
      homeDirectory: fixture.home,
      sharedRoot: fixture.sharedRoot,
      disabledRoot: fixture.disabledRoot,
      targetRoots: fixture.targetRoots,
    });

    expect(restarted.scan().skills[0]).toMatchObject({ ownership: "codebridge_managed" });
    expect(fs.realpathSync(path.join(fixture.targetRoots.claude, "database-query")))
      .toBe(fs.realpathSync(path.join(fixture.sharedRoot, "database-query")));
    const transactions = JSON.parse(fs.readFileSync(transactionsPath, "utf8")) as Record<string, { status: string }>;
    expect(transactions[transactionId]!.status).toBe("completed");
  });
});

describe("SkillControlPlane shared-directory model", () => {
  it("uses the directory name as identity and blocks a mismatched frontmatter name", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    const directory = path.join(fixture.sharedRoot, "database-query");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "SKILL.md"),
      "---\nname: another-name\ndescription: mismatch\n---\n",
      "utf8",
    );

    expect(fixture.service.scan().skills).toEqual([
      expect.objectContaining({
        id: "database-query",
        name: "another-name",
        global_state: "invalid",
        can_apply: false,
      }),
    ]);
  });

  it("hashes the complete behavioral package, including executable bits and internal links", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    const directory = createSkill(fixture.sharedRoot, "dcp");
    const script = path.join(directory, "bin", "run.sh");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "#!/bin/sh\necho first\n", { mode: 0o644 });
    fs.symlinkSync("bin/run.sh", path.join(directory, "run"));

    const initial = fixture.service.scan().skills[0]!.package_revision;
    fs.chmodSync(script, 0o755);
    const executable = fixture.service.scan().skills[0]!.package_revision;
    fs.writeFileSync(script, "#!/bin/sh\necho second\n", { mode: 0o755 });
    const content = fixture.service.scan().skills[0]!.package_revision;
    fs.unlinkSync(path.join(directory, "run"));
    fs.symlinkSync("SKILL.md", path.join(directory, "run"));
    const link = fixture.service.scan().skills[0]!.package_revision;

    expect(new Set([initial, executable, content, link])).toHaveLength(4);
  });

  it("detects active-disabled split brain without selecting a winner", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    createSkill(fixture.sharedRoot, "database-query", "active");
    createSkill(fixture.disabledRoot, "database-query", "disabled");

    expect(fixture.service.scan().skills).toEqual([
      expect.objectContaining({
        id: "database-query",
        global_state: "split_brain",
        can_apply: false,
      }),
    ]);
  });

  it("exposes shared-native targets as global followers and only Claude as mutable projection", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    createSkill(fixture.sharedRoot, "database-query");

    const skill = fixture.service.scan().skills[0]!;
    expect(skill.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agent_id: "codex",
        delivery_mode: "shared_native",
        state: "follows_global",
        mutable: false,
      }),
      expect.objectContaining({
        agent_id: "cursor",
        delivery_mode: "shared_native",
        state: "follows_global",
        mutable: false,
      }),
      expect.objectContaining({
        agent_id: "opencode",
        delivery_mode: "shared_native",
        state: "follows_global",
        mutable: false,
      }),
      expect.objectContaining({
        agent_id: "pi",
        delivery_mode: "shared_native",
        state: "follows_global",
        mutable: false,
      }),
      expect.objectContaining({
        agent_id: "claude",
        delivery_mode: "symlink_projection",
        state: "absent",
        mutable: true,
      }),
    ]));
  });
});
