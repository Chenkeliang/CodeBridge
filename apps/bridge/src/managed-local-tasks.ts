import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { SecretOptions } from "@codebridge/core";
import { replaceManagedFile } from "./management-files.js";

export interface CalendarTime { Hour?: number; Minute?: number; Weekday?: number; Day?: number; Month?: number }
export interface LocalTask {
  id: string; name: string; source: string; label: string; command: string;
  calendar: CalendarTime[]; interval: number | null; loaded: boolean; running: boolean;
  lastExitCode: number | null; revision: string;
}
interface Registration { id: string; name: string; source: string }
type Plist = Record<string, unknown> & { Label: string; ProgramArguments?: string[]; Program?: string; StartCalendarInterval?: CalendarTime | CalendarTime[]; StartInterval?: number };
export type LocalCommand = (command: string, args: string[], input?: string) => string;

/** Uses the host's existing scheduler. Definitions and registrations stay in private runtime files. */
export class LocalTaskManager {
  private readonly root: string;
  private readonly file: string;
  constructor(private readonly options: { dataDir: string; home?: string; platform?: string; run?: LocalCommand; secrets?: SecretOptions }) {
    this.root = path.join(options.home ?? os.homedir(), "Library", "LaunchAgents");
    this.file = path.join(options.dataDir, "managed-local-tasks.json");
  }
  private run(command: string, args: string[], input?: string): string {
    return (this.options.run ?? ((file, argv, stdin) => execFileSync(file, argv, {
      encoding: "utf8", input: stdin, timeout: 10_000, maxBuffer: 512_000, stdio: ["pipe", "pipe", "pipe"],
    })))(command, args, input);
  }
  private supported(): void {
    if ((this.options.platform ?? process.platform) !== "darwin") throw new Error("本地计划管理需要 macOS launchd");
  }
  private source(source: string): string {
    this.supported();
    const actual = fs.realpathSync(source);
    const root = fs.realpathSync(this.root);
    if (path.dirname(actual) !== root || !actual.endsWith(".plist") || !fs.statSync(actual).isFile()) {
      throw new Error("只能接入当前用户 LaunchAgents 目录中的 plist 文件");
    }
    return actual;
  }
  private registrations(): Registration[] {
    if (!fs.existsSync(this.file)) return [];
    const entries = JSON.parse(fs.readFileSync(this.file, "utf8")) as Registration[];
    if (!Array.isArray(entries)) throw new Error("本地任务登记文件无效");
    return entries;
  }
  private write(entries: Registration[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, this.file);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  private definition(source: string): { source: string; value: Plist; revision: string } {
    const actual = this.source(source);
    const raw = fs.readFileSync(actual);
    const value = JSON.parse(this.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", actual])) as Plist;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value.Label)) throw new Error("任务 Label 无效");
    return { source: actual, value, revision: createHash("sha256").update(raw).digest("hex") };
  }
  private domain(label: string): string { return `gui/${process.getuid!()}/${label}`; }
  private status(label: string) {
    try {
      const text = this.run("/bin/launchctl", ["print", this.domain(label)]);
      return { loaded: true, running: /\bpid = \d+/.test(text), lastExitCode: /last exit code = (-?\d+)/.test(text) ? Number(/last exit code = (-?\d+)/.exec(text)![1]) : null };
    } catch (error) {
      const detail = error as Error & { stderr?: Buffer | string };
      if (!/Could not find (?:specified )?service/i.test(`${detail.message} ${detail.stderr ?? ""}`)) throw error;
      return { loaded: false, running: false, lastExitCode: null };
    }
  }
  private view(entry: Registration): LocalTask {
    const { source, value, revision } = this.definition(entry.source);
    return { ...entry, source, label: value.Label, command: value.Program ?? value.ProgramArguments?.[0] ?? "",
      calendar: Array.isArray(value.StartCalendarInterval) ? value.StartCalendarInterval : value.StartCalendarInterval ? [value.StartCalendarInterval] : [],
      interval: value.StartInterval ?? null, ...this.status(value.Label), revision };
  }
  list(): { tasks: LocalTask[]; issues: Array<{ id: string; name: string; message: string }>; supported: boolean } {
    const tasks: LocalTask[] = [], issues: Array<{ id: string; name: string; message: string }> = [];
    for (const entry of this.registrations()) {
      try { tasks.push(this.view(entry)); }
      catch (error) { issues.push({ id: entry.id, name: entry.name, message: error instanceof Error ? error.message : "读取失败" }); }
    }
    return { tasks, issues, supported: (this.options.platform ?? process.platform) === "darwin" };
  }
  available(): Array<{ source: string; label: string }> {
    this.supported();
    if (!fs.existsSync(this.root)) return [];
    const registered = new Set(this.registrations().map((entry) => entry.source));
    return fs.readdirSync(this.root).filter((name) => name.endsWith(".plist")).flatMap((name) => {
      try { const { source, value } = this.definition(path.join(this.root, name));
        return registered.has(source) ? [] : [{ source, label: value.Label }];
      } catch { return []; }
    });
  }
  register(source: string, name: string): LocalTask {
    const definition = this.definition(source);
    const entries = this.registrations();
    if (!name.trim() || name.length > 100) throw new Error("请填写100字以内的任务名称");
    if (entries.some((entry) => entry.source === definition.source)) throw new Error("这个计划已经接入");
    const entry = { id: randomUUID(), name: name.trim(), source: definition.source };
    this.write([...entries, entry]);
    return this.view(entry);
  }
  act(id: string, action: "enable" | "disable" | "run", revision: string): LocalTask {
    const entry = this.registrations().find((candidate) => candidate.id === id);
    if (!entry) throw new Error("任务不存在");
    const task = this.view(entry);
    if (task.revision !== revision) throw new Error("计划已被其他程序修改，请刷新后重试");
    if (task.running) throw new Error("任务正在运行，请等本轮结束；不会强制停止已有任务");
    if (action === "disable") {
      this.run("/bin/launchctl", ["disable", this.domain(task.label)]);
      if (task.loaded) this.run("/bin/launchctl", ["bootout", this.domain(task.label)]);
    } else if (action === "enable") {
      this.run("/bin/launchctl", ["enable", this.domain(task.label)]);
      if (!task.loaded) this.run("/bin/launchctl", ["bootstrap", `gui/${process.getuid!()}`, task.source]);
    } else {
      if (!task.loaded) throw new Error("计划尚未启用，请先启用后手动运行");
      this.run("/bin/launchctl", ["kickstart", this.domain(task.label)]);
    }
    return this.view(entry);
  }
  schedule(id: string, calendar: CalendarTime[], interval: number | null, revision: string) {
    const entry = this.registrations().find((candidate) => candidate.id === id);
    if (!entry) throw new Error("任务不存在");
    const task = this.view(entry);
    if (task.running) throw new Error("任务正在运行，结束后再调整计划");
    if (task.revision !== revision) throw new Error("计划已改变，请刷新后重试");
    const ranges: Record<string, [number, number]> = { Hour: [0, 23], Minute: [0, 59], Weekday: [0, 7], Day: [1, 31], Month: [1, 12] };
    if (!Array.isArray(calendar) || calendar.length > 200 || (interval !== null && (!Number.isInteger(interval) || interval < 60 || calendar.length))) throw new Error("请设置日历计划或至少60秒的间隔，不能同时设置两者");
    for (const time of calendar) {
      if (!time || typeof time !== "object" || !Object.keys(time).length) throw new Error("日历时间不能为空");
      for (const [key, value] of Object.entries(time)) {
        const range = ranges[key];
        if (!range || !Number.isInteger(value) || value! < range[0] || value! > range[1]) throw new Error("日历时间字段或取值无效");
      }
    }
    const { value } = this.definition(task.source);
    delete value.StartCalendarInterval; delete value.StartInterval;
    if (calendar.length) value.StartCalendarInterval = calendar;
    if (interval !== null) value.StartInterval = interval;
    const content = this.run("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "-"], JSON.stringify(value));
    const result = replaceManagedFile(task.source, content, revision, this.options.dataDir, this.options.secrets);
    // Reload only idle jobs, retaining the prior running/paused state. Never kickstart a task while saving.
    if (task.loaded) {
      this.run("/bin/launchctl", ["bootout", this.domain(task.label)]);
      this.run("/bin/launchctl", ["bootstrap", `gui/${process.getuid!()}`, task.source]);
    }
    return { task: this.view(entry), backup: result.backup };
  }
  /** Detach management only; never removes the original definition or changes its schedule. */
  unregister(id: string): void { this.write(this.registrations().filter((entry) => entry.id !== id)); }
}
