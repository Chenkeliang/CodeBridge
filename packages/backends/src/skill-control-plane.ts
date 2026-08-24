import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonArrayStore } from "@codebridge/core";

export const SKILL_AGENT_IDS = ["codex", "claude", "cursor", "opencode", "pi"] as const;

export type SkillAgentId = (typeof SKILL_AGENT_IDS)[number];
export type SkillSourceKind = "shared" | "adopted" | "agent_native";
export type SkillProjectionState = "linked" | "absent" | "conflict" | "broken" | "native";
export type SkillAssignmentAction = "create_link" | "remove_link" | "noop" | "conflict";

export interface SkillTargetView {
  agent_id: SkillAgentId;
  target_path: string;
  state: SkillProjectionState;
  detail: string | null;
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  source_path: string;
  source_kind: SkillSourceKind;
  revision: string;
  tags: string[];
  updated_at: string;
  targets: SkillTargetView[];
}

export interface SkillTargetDefinition {
  agent_id: SkillAgentId;
  display_name: string;
  root_path: string;
}

export interface SkillCatalogSnapshot {
  skills: SkillCatalogEntry[];
  targets: SkillTargetDefinition[];
  summary: {
    total: number;
    sources: number;
    linked: number;
    issues: number;
  };
  scanned_at: string;
}

export interface SkillAssignmentInput {
  skill_id: string;
  agent_id: SkillAgentId;
  enabled: boolean;
}

export interface SkillAssignmentPreview {
  skill_id: string;
  skill_name: string;
  agent_id: SkillAgentId;
  enabled: boolean;
  source_path: string;
  target_path: string;
  current_state: SkillProjectionState;
  action: SkillAssignmentAction;
  detail: string | null;
  can_apply: boolean;
}

export interface SkillAssignmentResult extends SkillAssignmentPreview {
  state: SkillProjectionState;
}

export interface SkillControlPlaneOptions {
  dataDir: string;
  homeDirectory?: string;
  sharedRoot?: string;
  targetRoots?: Record<SkillAgentId, string>;
}

export type SkillControlPlaneErrorCode =
  | "skill_not_found"
  | "skill_source_invalid"
  | "skill_target_unknown"
  | "skill_target_conflict"
  | "skill_unlink_forbidden";

export class SkillControlPlaneError extends Error {
  override readonly name = "SkillControlPlaneError";

  constructor(
    public readonly code: SkillControlPlaneErrorCode,
    message: string,
    public readonly status: 400 | 404 | 409 = 409,
  ) {
    super(message);
  }
}

const TARGET_NAMES: Record<SkillAgentId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
};

const SOURCE_PRIORITY: Record<SkillSourceKind, number> = {
  shared: 3,
  adopted: 2,
  agent_native: 1,
};

interface DiscoveredSkill {
  sourcePath: string;
  sourceKind: SkillSourceKind;
}

export class SkillControlPlane {
  private readonly homeDirectory: string;
  private readonly sharedRoot: string;
  private readonly targetRoots: Record<SkillAgentId, string>;
  private readonly sources: JsonArrayStore<string>;

  constructor(options: SkillControlPlaneOptions) {
    this.homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
    this.sharedRoot = path.resolve(
      options.sharedRoot ?? path.join(this.homeDirectory, ".agents", "skills"),
    );
    this.targetRoots = options.targetRoots ?? {
      codex: path.join(this.homeDirectory, ".codex", "skills"),
      claude: path.join(this.homeDirectory, ".claude", "skills"),
      cursor: path.join(this.homeDirectory, ".cursor", "skills"),
      opencode: path.join(this.homeDirectory, ".config", "opencode", "skills"),
      pi: path.join(this.homeDirectory, ".pi", "agent", "skills"),
    };
    this.sources = new JsonArrayStore<string>(
      path.join(options.dataDir, "skill-sources.json"),
    );
  }

  scan(): SkillCatalogSnapshot {
    const discovered = new Map<string, DiscoveredSkill>();
    this.collectRoot(this.sharedRoot, "shared", discovered);
    for (const source of this.sources.read()) {
      this.collectRoot(source, "adopted", discovered);
    }
    for (const agentId of SKILL_AGENT_IDS) {
      this.collectRoot(this.targetRoots[agentId], "agent_native", discovered);
    }

    const skills = [...discovered.values()]
      .map((skill) => this.toCatalogEntry(skill))
      .sort((left, right) => left.name.localeCompare(right.name));
    const targets = SKILL_AGENT_IDS.map((agentId) => ({
      agent_id: agentId,
      display_name: TARGET_NAMES[agentId],
      root_path: this.targetRoots[agentId],
    }));
    return {
      skills,
      targets,
      summary: {
        total: skills.length,
        sources: new Set(skills.map((skill) => skill.source_kind)).size,
        linked: skills.flatMap((skill) => skill.targets)
          .filter((target) => target.state === "linked" || target.state === "native").length,
        issues: skills.flatMap((skill) => skill.targets)
          .filter((target) => target.state === "conflict" || target.state === "broken").length,
      },
      scanned_at: new Date().toISOString(),
    };
  }

  addSource(rawPath: string): SkillCatalogSnapshot {
    if (!path.isAbsolute(rawPath)) {
      throw new SkillControlPlaneError(
        "skill_source_invalid",
        "Skill Source 必须使用绝对路径",
        400,
      );
    }
    let resolved: string;
    try {
      resolved = fs.realpathSync(rawPath);
    } catch {
      throw new SkillControlPlaneError(
        "skill_source_invalid",
        `Skill Source 不存在或不可访问: ${rawPath}`,
        400,
      );
    }
    if (!this.skillDirectories(resolved).length) {
      throw new SkillControlPlaneError(
        "skill_source_invalid",
        "所选目录自身或直接子目录中没有 SKILL.md",
        400,
      );
    }
    this.sources.update((current) => (
      current.includes(resolved) ? current : [...current, resolved]
    ));
    return this.scan();
  }

  preview(input: SkillAssignmentInput): SkillAssignmentPreview {
    const skill = this.findSkill(input.skill_id);
    if (!SKILL_AGENT_IDS.includes(input.agent_id)) {
      throw new SkillControlPlaneError(
        "skill_target_unknown",
        `未知 Agent Target: ${String(input.agent_id)}`,
        400,
      );
    }
    const target = skill.targets.find((candidate) => candidate.agent_id === input.agent_id)!;
    let action: SkillAssignmentAction;
    if (input.enabled) {
      action = target.state === "absent"
        ? "create_link"
        : target.state === "linked" || target.state === "native"
          ? "noop"
          : "conflict";
    } else {
      action = target.state === "linked"
        ? "remove_link"
        : target.state === "absent"
          ? "noop"
          : "conflict";
    }
    return {
      skill_id: skill.id,
      skill_name: skill.name,
      agent_id: input.agent_id,
      enabled: input.enabled,
      source_path: skill.source_path,
      target_path: target.target_path,
      current_state: target.state,
      action,
      detail: target.detail,
      can_apply: action !== "conflict",
    };
  }

  apply(input: SkillAssignmentInput): SkillAssignmentResult {
    const preview = this.preview(input);
    if (preview.action === "conflict") {
      throw new SkillControlPlaneError(
        input.enabled ? "skill_target_conflict" : "skill_unlink_forbidden",
        preview.detail ?? (
          input.enabled
            ? `Target 已被其他内容占用: ${preview.target_path}`
            : `禁止移除非受管软链或目录: ${preview.target_path}`
        ),
      );
    }
    if (preview.action === "create_link") {
      fs.mkdirSync(path.dirname(preview.target_path), { recursive: true });
      const current = this.preview(input);
      if (current.action === "create_link") {
        fs.symlinkSync(preview.source_path, preview.target_path, "dir");
      } else if (current.action !== "noop") {
        throw new SkillControlPlaneError(
          "skill_target_conflict",
          current.detail ?? `Target 在 Apply 前发生变化: ${current.target_path}`,
        );
      }
    }
    if (preview.action === "remove_link") {
      const current = this.preview(input);
      if (current.action === "remove_link") {
        if (!this.isManagedLink(current.target_path, current.source_path)) {
          throw new SkillControlPlaneError(
            "skill_unlink_forbidden",
            `Target 不再是请求 Source 的受管软链: ${current.target_path}`,
          );
        }
        fs.unlinkSync(current.target_path);
      } else if (current.action !== "noop") {
        throw new SkillControlPlaneError(
          "skill_unlink_forbidden",
          current.detail ?? `Target 在 Apply 前发生变化: ${current.target_path}`,
        );
      }
    }
    const refreshed = this.findSkill(input.skill_id);
    const state = refreshed.targets.find((target) => target.agent_id === input.agent_id)?.state;
    if (!state) {
      throw new SkillControlPlaneError("skill_not_found", "Apply 后无法重新读取 Skill", 404);
    }
    if (input.enabled && state !== "linked" && state !== "native") {
      throw new SkillControlPlaneError(
        "skill_target_conflict",
        `Apply 后 Target 未进入可见状态: ${state}`,
      );
    }
    if (!input.enabled && state !== "absent") {
      throw new SkillControlPlaneError(
        "skill_unlink_forbidden",
        `Apply 后 Target 仍然存在: ${state}`,
      );
    }
    return { ...preview, state };
  }

  private findSkill(id: string): SkillCatalogEntry {
    const skill = this.scan().skills.find((candidate) => candidate.id === id);
    if (!skill) {
      throw new SkillControlPlaneError("skill_not_found", `Skill 不存在: ${id}`, 404);
    }
    return skill;
  }

  private collectRoot(
    root: string,
    sourceKind: SkillSourceKind,
    discovered: Map<string, DiscoveredSkill>,
  ): void {
    for (const sourcePath of this.skillDirectories(root)) {
      const current = discovered.get(sourcePath);
      if (!current || SOURCE_PRIORITY[sourceKind] > SOURCE_PRIORITY[current.sourceKind]) {
        discovered.set(sourcePath, { sourcePath, sourceKind });
      }
    }
  }

  private skillDirectories(root: string): string[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      return [];
    }
    if (!stat.isDirectory()) return [];
    const direct = this.resolveSkillDirectory(root);
    if (direct) return [direct];
    const result: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const resolved = this.resolveSkillDirectory(path.join(root, entry.name));
      if (resolved && !result.includes(resolved)) result.push(resolved);
    }
    return result;
  }

  private resolveSkillDirectory(candidate: string): string | null {
    try {
      const resolved = fs.realpathSync(candidate);
      if (!fs.statSync(resolved).isDirectory()) return null;
      if (!fs.statSync(path.join(resolved, "SKILL.md")).isFile()) return null;
      return resolved;
    } catch {
      return null;
    }
  }

  private toCatalogEntry(discovered: DiscoveredSkill): SkillCatalogEntry {
    const skillFile = path.join(discovered.sourcePath, "SKILL.md");
    const content = fs.readFileSync(skillFile, "utf8");
    const metadata = parseSkillMetadata(content, path.basename(discovered.sourcePath));
    return {
      id: digest(discovered.sourcePath).slice(0, 16),
      name: metadata.name,
      description: metadata.description,
      source_path: discovered.sourcePath,
      source_kind: discovered.sourceKind,
      revision: digest(content),
      tags: metadata.tags,
      updated_at: fs.statSync(skillFile).mtime.toISOString(),
      targets: SKILL_AGENT_IDS.map((agentId) => this.inspectTarget(discovered.sourcePath, agentId)),
    };
  }

  private inspectTarget(sourcePath: string, agentId: SkillAgentId): SkillTargetView {
    const targetPath = path.join(this.targetRoots[agentId], path.basename(sourcePath));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(targetPath);
    } catch {
      return { agent_id: agentId, target_path: targetPath, state: "absent", detail: null };
    }
    let resolvedTarget: string | null = null;
    try {
      resolvedTarget = fs.realpathSync(targetPath);
    } catch {
      resolvedTarget = null;
    }
    if (!stat.isSymbolicLink() && resolvedTarget === sourcePath) {
      return {
        agent_id: agentId,
        target_path: targetPath,
        state: "native",
        detail: "Skill 由 Agent 原生目录直接管理",
      };
    }
    if (stat.isSymbolicLink()) {
      if (!resolvedTarget) {
        return {
          agent_id: agentId,
          target_path: targetPath,
          state: "broken",
          detail: "Target 是无法解析的软链",
        };
      }
      if (resolvedTarget === sourcePath && this.resolveSkillDirectory(targetPath)) {
        return {
          agent_id: agentId,
          target_path: targetPath,
          state: "linked",
          detail: "目标目录可见且 SKILL.md 可读",
        };
      }
      return {
        agent_id: agentId,
        target_path: targetPath,
        state: "conflict",
        detail: `Target 已指向其他 Source: ${resolvedTarget}`,
      };
    }
    return {
      agent_id: agentId,
      target_path: targetPath,
      state: "conflict",
      detail: "Target 已存在且不是受管软链",
    };
  }

  private isManagedLink(targetPath: string, sourcePath: string): boolean {
    try {
      return fs.lstatSync(targetPath).isSymbolicLink()
        && fs.realpathSync(targetPath) === sourcePath;
    } catch {
      return false;
    }
  }
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseSkillMetadata(content: string, fallbackName: string): {
  name: string;
  description: string | null;
  tags: string[];
} {
  const frontmatter = content.startsWith("---\n")
    ? content.slice(4, content.indexOf("\n---", 4) >= 0 ? content.indexOf("\n---", 4) : 4)
    : "";
  const fields = new Map<string, string>();
  for (const line of frontmatter.split("\n")) {
    const match = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    fields.set(match[1]!, unquote(match[2]!.trim()));
  }
  const rawTags = fields.get("tags") ?? "";
  const tags = rawTags.replace(/^\[|\]$/g, "").split(",")
    .map((tag) => unquote(tag.trim()))
    .filter(Boolean);
  return {
    name: fields.get("name") || fallbackName,
    description: fields.get("description") || null,
    tags,
  };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
