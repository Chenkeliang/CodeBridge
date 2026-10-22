import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecipheriv } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalTaskManager } from "./managed-local-tasks.js";
import { ManagedRunbooks } from "./managed-runbooks.js";
import { fileRevision } from "./management-files.js";

const keys = vi.hoisted(() => new Map<string, string>());
vi.mock("@codebridge/core", async (original) => ({ ...await original<typeof import("@codebridge/core")>(),
  storeKeychainSecret: (service: string, value: string) => keys.set(service, value), resolveSecretRef: (ref: string) => keys.get(ref.slice(9))!,
}));
const roots: string[] = [];
afterEach(() => { keys.clear(); roots.splice(0).forEach((p) => fs.rmSync(p, { recursive: true, force: true })); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-managed-resource-test-")); roots.push(root);
  const dataDir = path.join(root, "data"), dir = path.join(root, "Library", "LaunchAgents"); fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, "fixture.report.plist");
  fs.writeFileSync(source, JSON.stringify({ Label: "fixture.report", ProgramArguments: ["/fixture/python", "/fixture/report.py"], EnvironmentVariables: { FIXTURE_PRIVATE: "private-runtime-value" }, StartCalendarInterval: [{ Hour: 9, Minute: 30 }], RunAtLoad: false }));
  let loaded = true, running = false;
  const run = vi.fn((command: string, args: string[], input?: string) => {
    if (command === "/usr/bin/plutil") return input ?? fs.readFileSync(args.at(-1)!, "utf8");
    if (args[0] === "print") { if (!loaded) throw new Error("Could not find service"); return running ? "pid = 123\n" : "last exit code = 0\n"; }
    if (args[0] === "bootout") loaded = false;
    if (args[0] === "bootstrap") loaded = true;
    return "";
  });
  const manager = new LocalTaskManager({ dataDir, home: root, platform: "darwin", run });
  return { root, dataDir, source, manager, run, running: () => { running = true; } };
}
describe("host launchd task management", () => {
  it("observes and registers existing jobs without running or rescheduling them", () => {
    const f = fixture(), before = fs.readFileSync(f.source, "utf8");
    expect(f.manager.available()).toEqual([{ source: fs.realpathSync(f.source), label: "fixture.report" }]);
    f.manager.register(f.source, "Fixture report");
    expect(fs.readFileSync(f.source, "utf8")).toBe(before);
    expect(f.run.mock.calls.some(([, args]) => ["kickstart", "bootstrap", "bootout"].includes(args[0]!))).toBe(false);
    expect(f.manager.list().tasks[0]?.lastExitCode).toBe(0);
    expect(JSON.stringify(f.manager.list())).not.toContain("private-runtime-value");
  });
  it("rejects unregistered/outside and symlinked outside files", () => {
    const f = fixture(), outside = path.join(f.root, "outside.plist"); fs.copyFileSync(f.source, outside);
    const link = path.join(path.dirname(f.source), "link.plist"); fs.symlinkSync(outside, link);
    expect(() => f.manager.register(outside, "Outside")).toThrow("LaunchAgents");
    expect(() => f.manager.register(link, "Outside")).toThrow("LaunchAgents");
    expect(() => f.manager.act("unknown", "run", "anything")).toThrow("不存在");
  });
  it("does not stop or run an active job; manual runs never use force-kill", () => {
    const f = fixture(), task = f.manager.register(f.source, "Report");
    f.manager.act(task.id, "run", task.revision);
    expect(f.run).toHaveBeenCalledWith("/bin/launchctl", ["kickstart", expect.any(String)], undefined);
    f.running(); const count = f.run.mock.calls.length;
    expect(() => f.manager.act(task.id, "disable", task.revision)).toThrow("正在运行");
    expect(f.run.mock.calls.slice(count).some(([, args]) => args[0] === "bootout")).toBe(false);
  });
  it("persists disabled status through the native scheduler", () => {
    const f = fixture(), task = f.manager.register(f.source, "Report");
    expect(f.manager.act(task.id, "disable", task.revision).loaded).toBe(false);
    expect(f.run).toHaveBeenCalledWith("/bin/launchctl", ["disable", expect.any(String)], undefined);
    expect(f.manager.act(task.id, "enable", task.revision).loaded).toBe(true);
  });
  it("saves schedules with an encrypted recovery copy and preserves command/environment", () => {
    const f = fixture(), task = f.manager.register(f.source, "Report"), before = fs.readFileSync(f.source, "utf8");
    const saved = f.manager.schedule(task.id, [{ Hour: 17, Minute: 30, Weekday: 1 }], null, task.revision);
    const disk = JSON.parse(fs.readFileSync(f.source, "utf8"));
    expect(disk.ProgramArguments).toEqual(["/fixture/python", "/fixture/report.py"]);
    expect(disk.EnvironmentVariables.FIXTURE_PRIVATE).toBe("private-runtime-value");
    expect(disk.StartCalendarInterval).toEqual([{ Hour: 17, Minute: 30, Weekday: 1 }]);
    const backup = JSON.parse(fs.readFileSync(saved.backup, "utf8"));
    expect(JSON.stringify(backup)).not.toContain("private-runtime-value");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keys.get(backup.keyRef.slice(9))!, "base64"), Buffer.from(backup.iv, "base64")); decipher.setAuthTag(Buffer.from(backup.tag, "base64"));
    expect(Buffer.concat([decipher.update(Buffer.from(backup.ciphertext, "base64")), decipher.final()]).toString()).toBe(before);
  });
  it("reports scheduler permission failures instead of presenting the job as stopped", () => {
    const f = fixture(); f.manager.register(f.source, "Report");
    f.run.mockImplementation(() => { throw new Error("Operation not permitted"); });
    expect(f.manager.list().issues[0]?.message).toContain("Operation not permitted");
    expect(f.manager.list().tasks).toEqual([]);
  });
  it("rejects stale and invalid schedules without changing user data", () => {
    const f = fixture(), task = f.manager.register(f.source, "Report"), before = fs.readFileSync(f.source, "utf8");
    expect(() => f.manager.schedule(task.id, [{ Hour: 99 }], null, task.revision)).toThrow("无效");
    expect(() => f.manager.schedule(task.id, [], 1, task.revision)).toThrow("60秒");
    expect(() => f.manager.schedule(task.id, [{ Hour: 9 }], null, "old-revision")).toThrow("已改变");
    expect(fs.readFileSync(f.source, "utf8")).toBe(before);
  });
});
describe("standard external Skill maintenance", () => {
  function skill() {
    const f = fixture(), root = path.join(f.root, "skills", "fixture"), refs = path.join(root, "references"); fs.mkdirSync(refs, { recursive: true });
    const entry = path.join(root, "SKILL.md"); fs.writeFileSync(entry, "---\nname: fixture\ndescription: Fixture rules\n---\nRead [matrix](references/matrix.md).\n");
    fs.writeFileSync(path.join(refs, "matrix.md"), "# Original fixture matrix\n");
    return { ...f, entry, root, books: new ManagedRunbooks(f.dataDir) };
  }
  it("follows a standard Skill directory without copying it into the application", () => {
    const f = skill(), mirror = path.join(f.root, "mirror"); fs.symlinkSync(path.dirname(f.entry), mirror);
    expect(f.books.inspect(path.join(mirror, "SKILL.md")).name).toBe("fixture");
    expect(f.books.read(f.entry, "references/matrix.md").content).toContain("Original fixture");
  });
  it("uses version checks, validates references and preserves the real symlink target", () => {
    const f = skill(), read = f.books.read(f.entry, "references/matrix.md");
    const saved = f.books.save(f.entry, read.relative, "# Updated fixture matrix\n", read.revision);
    expect(saved.revision).toBe(fileRevision(path.join(f.root, read.relative)));
    expect(() => f.books.save(f.entry, read.relative, "# stale\n", read.revision)).toThrow("其他程序");
    expect(() => f.books.save(f.entry, "SKILL.md", "invalid frontmatter", fileRevision(f.entry))).toThrow("frontmatter");
    expect(() => f.books.save(f.entry, "SKILL.md", read.content + "[broken](references/missing.md)", fileRevision(f.entry))).toThrow();
  });
  it("lists the selected group's reference files and allows broken JSON to be repaired", () => {
    const f = skill(), group = path.join(f.root, "groups", "fixture"); fs.mkdirSync(path.join(group, "references"), { recursive: true });
    const entry = path.join(group, "runbook.md"); fs.writeFileSync(entry, "# Fixture instructions\n");
    const matrix = path.join(group, "references", "matrix.md"); fs.writeFileSync(matrix, "# Fixture matrix\n");
    const rules = path.join(group, "references", "notification-rules.json"); fs.writeFileSync(rules, "invalid JSON");
    expect(() => f.books.inspect(entry)).toThrow();
    const read = f.books.read(entry, "groups/fixture/references/notification-rules.json");
    expect(read.files).toContain("groups/fixture/references/matrix.md"); expect(read.issues.length).toBeGreaterThan(0);
    f.books.save(entry, read.relative, '{"rules":[]}', read.revision);
    expect(f.books.inspect(entry).issues).toEqual([]);
    expect(() => f.books.save(entry, "groups/fixture/runbook.md", "x".repeat(64_001), fileRevision(entry))).toThrow("64KB");
  });
  it("rejects file traversal and external symlink references", () => {
    const f = skill(); fs.writeFileSync(path.join(f.root, "..", "outside.md"), "private fixture");
    fs.symlinkSync(path.join(f.root, "..", "outside.md"), path.join(f.root, "references", "outside.md"));
    expect(() => f.books.read(f.entry, "../outside.md")).toThrow("越出");
    expect(() => f.books.read(f.entry, "references/outside.md")).toThrow("越出");
  });
});
