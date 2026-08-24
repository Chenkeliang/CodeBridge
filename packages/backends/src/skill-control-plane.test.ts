import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SkillControlPlane,
  SkillControlPlaneError,
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
  const targetRoots = {
    codex: path.join(home, ".codex", "skills"),
    claude: path.join(home, ".claude", "skills"),
    cursor: path.join(home, ".cursor", "skills"),
    opencode: path.join(home, ".config", "opencode", "skills"),
    pi: path.join(home, ".pi", "agent", "skills"),
  } as const;
  fs.mkdirSync(sharedRoot, { recursive: true });
  return {
    home,
    dataDir,
    sharedRoot,
    targetRoots,
    service: new SkillControlPlane({ dataDir, homeDirectory: home, targetRoots }),
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
          expect.objectContaining({ agent_id: "cursor", state: "native" }),
        ]),
      }),
    ]));
    expect(snapshot.summary.total).toBe(3);
    expect(snapshot.targets).toHaveLength(5);
    expect(snapshot.skills.every((skill) => /^[a-f0-9]{16}$/.test(skill.id))).toBe(true);
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

describe("SkillControlPlane assignments", () => {
  it("previews, creates, verifies, and idempotently removes a managed link", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    createSkill(fixture.sharedRoot, "database-query");
    const skill = fixture.service.scan().skills[0]!;

    expect(fixture.service.preview({
      skill_id: skill.id,
      agent_id: "codex",
      enabled: true,
    })).toMatchObject({ action: "create_link", current_state: "absent" });

    const applied = fixture.service.apply({
      skill_id: skill.id,
      agent_id: "codex",
      enabled: true,
    });
    expect(applied).toMatchObject({ action: "create_link", state: "linked" });
    expect(fs.realpathSync(path.join(fixture.targetRoots.codex, "database-query"))).toBe(skill.source_path);

    expect(fixture.service.apply({
      skill_id: skill.id,
      agent_id: "codex",
      enabled: true,
    })).toMatchObject({ action: "noop", state: "linked" });

    expect(fixture.service.apply({
      skill_id: skill.id,
      agent_id: "codex",
      enabled: false,
    })).toMatchObject({ action: "remove_link", state: "absent" });
    expect(fs.existsSync(path.join(fixture.targetRoots.codex, "database-query"))).toBe(false);
  });

  it("reports and preserves an ordinary-directory conflict", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    createSkill(fixture.sharedRoot, "database-query");
    createSkill(fixture.targetRoots.codex, "database-query", "foreign copy");
    const skill = fixture.service.scan().skills.find((entry) => entry.source_kind === "shared")!;

    expect(fixture.service.preview({
      skill_id: skill.id,
      agent_id: "codex",
      enabled: true,
    })).toMatchObject({ action: "conflict", current_state: "conflict" });
    expect(() => fixture.service.apply({
      skill_id: skill.id,
      agent_id: "codex",
      enabled: true,
    })).toThrowError(expect.objectContaining({ code: "skill_target_conflict" }));
    expect(fs.statSync(path.join(fixture.targetRoots.codex, "database-query")).isDirectory()).toBe(true);
  });

  it("never removes a native directory or a foreign symlink", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    const source = createSkill(fixture.sharedRoot, "database-query");
    const foreignRoot = path.join(root, "foreign");
    const foreign = createSkill(foreignRoot, "database-query");
    fs.mkdirSync(fixture.targetRoots.pi, { recursive: true });
    fs.symlinkSync(foreign, path.join(fixture.targetRoots.pi, "database-query"), "dir");
    const skill = fixture.service.scan().skills.find(
      (entry) => entry.source_path === fs.realpathSync(source),
    )!;

    expect(() => fixture.service.apply({
      skill_id: skill.id,
      agent_id: "pi",
      enabled: false,
    })).toThrowError(expect.objectContaining({ code: "skill_unlink_forbidden" }));
    expect(fs.lstatSync(path.join(fixture.targetRoots.pi, "database-query")).isSymbolicLink()).toBe(true);
  });

  it("exposes a broken target without deleting it", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    createSkill(fixture.sharedRoot, "database-query");
    fs.mkdirSync(fixture.targetRoots.opencode, { recursive: true });
    fs.symlinkSync(path.join(root, "missing"), path.join(fixture.targetRoots.opencode, "database-query"), "dir");
    const skill = fixture.service.scan().skills.find((entry) => entry.source_kind === "shared")!;

    expect(skill.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: "opencode", state: "broken" }),
    ]));
    expect(() => fixture.service.apply({
      skill_id: skill.id,
      agent_id: "opencode",
      enabled: false,
    })).toThrowError(SkillControlPlaneError);
    expect(fs.lstatSync(path.join(fixture.targetRoots.opencode, "database-query")).isSymbolicLink()).toBe(true);
  });

  it("treats a moved Source as a new Skill and preserves the old broken link", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    const collection = path.join(root, "collection");
    const original = createSkill(collection, "database-query");
    fixture.service.addSource(collection);
    const originalSkill = fixture.service.scan().skills.find((entry) => entry.source_path === fs.realpathSync(original))!;
    fixture.service.apply({ skill_id: originalSkill.id, agent_id: "codex", enabled: true });

    const movedCollection = path.join(root, "moved");
    fs.renameSync(collection, movedCollection);
    fixture.service.addSource(movedCollection);
    const moved = fs.realpathSync(path.join(movedCollection, "database-query"));
    const movedSkill = fixture.service.scan().skills.find((entry) => entry.source_path === moved)!;

    expect(movedSkill.id).not.toBe(originalSkill.id);
    expect(movedSkill.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: "codex", state: "broken" }),
    ]));
    expect(() => fixture.service.apply({
      skill_id: movedSkill.id,
      agent_id: "codex",
      enabled: true,
    })).toThrowError(expect.objectContaining({ code: "skill_target_conflict" }));
    expect(fs.lstatSync(path.join(fixture.targetRoots.codex, "database-query")).isSymbolicLink()).toBe(true);
  });

  it("keeps same-name Sources distinct and refuses to overwrite the selected projection", () => {
    const root = temporaryRoot();
    const fixture = createControlPlane(root);
    const firstCollection = path.join(root, "first");
    const secondCollection = path.join(root, "second");
    const first = createSkill(firstCollection, "database-query", "first source");
    const second = createSkill(secondCollection, "database-query", "second source");
    fixture.service.addSource(firstCollection);
    fixture.service.addSource(secondCollection);
    const snapshot = fixture.service.scan();
    const firstSkill = snapshot.skills.find((entry) => entry.source_path === fs.realpathSync(first))!;
    const secondSkill = snapshot.skills.find((entry) => entry.source_path === fs.realpathSync(second))!;

    expect(firstSkill.id).not.toBe(secondSkill.id);
    fixture.service.apply({ skill_id: firstSkill.id, agent_id: "claude", enabled: true });
    expect(fixture.service.preview({
      skill_id: secondSkill.id,
      agent_id: "claude",
      enabled: true,
    })).toMatchObject({ action: "conflict", current_state: "conflict" });
    expect(fs.realpathSync(path.join(fixture.targetRoots.claude, "database-query"))).toBe(firstSkill.source_path);
  });
});
