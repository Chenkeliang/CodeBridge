import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { SecretOptions } from "@codebridge/core";
import { fileRevision, replaceManagedFile } from "./management-files.js";

/** The existing external Skill package remains the only source of business rules. */
export class ManagedRunbooks {
  constructor(private readonly dataDir: string, private readonly secrets?: SecretOptions) {}
  inspect(entry: string, strict = true) {
    const source = fs.realpathSync(entry);
    if (!fs.statSync(source).isFile()) throw new Error("规则入口不是文件");
    let root = path.dirname(source);
    while (!fs.existsSync(path.join(root, "SKILL.md"))) {
      const parent = path.dirname(root);
      if (parent === root) throw new Error("规则入口必须位于含 SKILL.md 的标准 Skill 目录中");
      root = parent;
    }
    const relative = path.relative(root, source);
    const files = new Set(["SKILL.md", relative]);
    const collect = (directory: string, depth: number) => {
      if (!fs.existsSync(directory)) return;
      if (depth > 4) throw new Error("references 目录超过四层，请简化规则结构");
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, item.name);
        if (item.isDirectory()) collect(candidate, depth + 1);
        else if (item.isFile() && /\.(md|json)$/i.test(item.name)) files.add(path.relative(root, candidate));
        if (files.size > 128) throw new Error("规则引用文件超过128个，请按任务拆分 Skill");
      }
    };
    collect(path.join(path.dirname(source), "references"), 0);
    const issues: string[] = [];
    let metadata = { name: path.basename(root), description: "" };
    try { metadata = this.metadata(fs.readFileSync(path.join(root, "SKILL.md"), "utf8")); }
    catch (error) { issues.push((error as Error).message); }
    for (const file of files) {
      try {
        const content = fs.readFileSync(this.target(root, file), "utf8");
        this.validate(root, file, content);
        if (file === relative && Buffer.byteLength(content) > 64_000) throw new Error("告警入口超过64KB，请将详细规则移到 references");
      } catch (error) { issues.push(`${file}: ${(error as Error).message}`); }
    }
    if (strict && issues.length) throw new Error(issues.join("；"));
    return { root, entry: relative, name: metadata.name, description: metadata.description, files: [...files], issues };
  }
  private metadata(text: string): { name: string; description: string } {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    const meta = match ? parse(match[1]) as Record<string, unknown> : null;
    if (!meta || typeof meta.name !== "string" || !meta.name.trim() || typeof meta.description !== "string" || !meta.description.trim()) {
      throw new Error("SKILL.md 需要包含 name 和 description 的 YAML frontmatter");
    }
    return { name: meta.name, description: meta.description };
  }
  private target(root: string, relative: string): string {
    if (path.isAbsolute(relative)) throw new Error("只能读取当前 Skill 内的相对路径");
    const target = fs.realpathSync(path.resolve(root, relative));
    if (!target.startsWith(`${root}${path.sep}`) || !fs.statSync(target).isFile()) throw new Error("文件越出当前 Skill 目录");
    if (!/\.(md|json)$/i.test(target)) throw new Error("这里只维护 Markdown 规则和 JSON 通知规则，脚本沿用原 Skill 工具维护");
    if (fs.statSync(target).size > 256_000) throw new Error("规则文件超过256KB，请拆分到 references");
    return target;
  }
  private validate(root: string, relative: string, content: string): void {
    if (Buffer.byteLength(content) > 256_000 || !content.trim()) throw new Error("规则内容不能为空或超过256KB");
    if (relative === "SKILL.md") this.metadata(content);
    if (relative.endsWith(".json")) {
      const data = JSON.parse(content) as { rules?: unknown };
      if (path.basename(relative) === "notification-rules.json" && !Array.isArray(data.rules)) throw new Error("通知规则必须含 rules 数组");
    }
    if (relative.endsWith(".md")) for (const match of content.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const link = match[1]!.split("#")[0]!;
      if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
      // Cross-Skill dependencies may be referenced, but this API never reads or writes them.
      fs.realpathSync(path.resolve(root, path.dirname(relative), decodeURIComponent(link)));
    }
  }
  read(entry: string, relative: string) {
    const info = this.inspect(entry, false);
    const target = this.target(info.root, relative);
    return { ...info, relative, content: fs.readFileSync(target, "utf8"), revision: fileRevision(target) };
  }
  save(entry: string, relative: string, content: string, revision: string) {
    const info = this.inspect(entry, false);
    const target = this.target(info.root, relative);
    this.validate(info.root, relative, content);
    if (relative === info.entry && Buffer.byteLength(content) > 64_000) throw new Error("告警入口超过64KB，请将详细规则移到 references");
    return { ...replaceManagedFile(target, content, revision, this.dataDir, this.secrets), relative };
  }
}
