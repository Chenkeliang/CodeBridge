import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonArrayStore, JsonMapStore } from "@codebridge/core";

export const SKILL_AGENT_IDS = ["codex", "claude", "cursor", "opencode", "pi"] as const;

export type SkillAgentId = (typeof SKILL_AGENT_IDS)[number];
export type SkillSourceKind = "shared" | "disabled" | "adopted" | "agent_native";
export type SkillGlobalState = "enabled" | "disabled" | "split_brain" | "external" | "invalid";
export type SkillDeliveryMode = "shared_native" | "symlink_projection";
export type SkillOwnership = "codebridge_managed" | "external_observed" | "native_managed";
export type SkillProjectionState = "follows_global" | "linked" | "absent" | "conflict" | "broken";

export interface SkillTargetView {
  agent_id: SkillAgentId;
  delivery_mode: SkillDeliveryMode;
  target_path: string;
  state: SkillProjectionState;
  mutable: boolean;
  detail: string | null;
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  source_path: string;
  source_kind: SkillSourceKind;
  package_revision: string;
  revision: string;
  global_state: SkillGlobalState;
  ownership: SkillOwnership;
  can_apply: boolean;
  tags: string[];
  updated_at: string;
  targets: SkillTargetView[];
}

export interface SkillTargetDefinition {
  agent_id: SkillAgentId;
  display_name: string;
  root_path: string;
  delivery_mode: SkillDeliveryMode;
}

export interface SkillCatalogSnapshot {
  skills: SkillCatalogEntry[];
  targets: SkillTargetDefinition[];
  summary: {
    total: number;
    sources: number;
    linked: number;
    issues: number;
    recovery_required?: number;
  };
  scanned_at: string;
}

export type SkillMutationKind = "global_state" | "assignment" | "adopt" | "unmanage";

export interface SkillMutationStep {
  action: "move" | "create_link" | "remove_link" | "set_ownership" | "set_assignment";
  source_path?: string;
  target_path?: string;
  detail: string;
}

export interface SkillMutationPlan {
  plan_id: string;
  actor_id: string;
  kind: SkillMutationKind;
  skill_id: string;
  package_revision: string;
  source_path: string;
  target_path: string;
  source_fingerprint: string;
  target_fingerprint: string;
  expires_at: string;
  steps: SkillMutationStep[];
  can_apply: boolean;
  detail: string | null;
  request: {
    enabled?: boolean;
    agent_id?: SkillAgentId;
  };
}

export interface SkillMutationResult {
  plan_id: string;
  transaction_id: string;
  snapshot: SkillCatalogSnapshot;
}

export interface SkillControlPlaneOptions {
  dataDir: string;
  homeDirectory?: string;
  sharedRoot?: string;
  disabledRoot?: string;
  targetRoots?: Record<SkillAgentId, string>;
}

export type SkillControlPlaneErrorCode =
  | "skill_not_found"
  | "skill_source_invalid"
  | "skill_target_unknown"
  | "skill_target_conflict"
  | "skill_unlink_forbidden"
  | "skill_package_invalid"
  | "skill_identity_mismatch"
  | "skill_split_brain"
  | "skill_revision_mismatch"
  | "skill_plan_not_found"
  | "skill_plan_expired"
  | "skill_plan_actor_mismatch"
  | "skill_adopt_forbidden"
  | "skill_transaction_recovery_required";

export class SkillControlPlaneError extends Error {
  override readonly name = "SkillControlPlaneError";

  constructor(
    public readonly code: SkillControlPlaneErrorCode,
    message: string,
    public readonly status: 400 | 404 | 409 | 422 = 409,
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
  shared: 4,
  disabled: 3,
  adopted: 2,
  agent_native: 1,
};

interface DiscoveredSkill {
  sourcePath: string;
  sourceKind: SkillSourceKind;
}

interface SkillOwnershipRecord {
  ownership: SkillOwnership;
  source_path: string;
  adopted_at: string;
  last_observed_revision: string;
}

interface SkillAssignmentRecord {
  skill_id: string;
  agent_id: SkillAgentId;
  desired_state: "linked" | "absent";
  target_path: string;
  created_link_target?: string;
  last_applied_package_revision: string;
  created_at: string;
  updated_at: string;
}

interface SkillTransactionRecord {
  transaction_id: string;
  plan_id: string;
  kind: SkillMutationKind;
  status: "pending" | "completed" | "failed";
  stage: "planned" | "source_switched" | "links_reconciled" | "verified" | "committed";
  created_at: string;
  updated_at: string;
  error?: string;
}

export class SkillControlPlane {
  private readonly homeDirectory: string;
  private readonly sharedRoot: string;
  private readonly disabledRoot: string;
  private readonly targetRoots: Record<SkillAgentId, string>;
  private readonly sources: JsonArrayStore<string>;
  private readonly ownership: JsonMapStore<SkillOwnershipRecord>;
  private readonly assignments: JsonMapStore<SkillAssignmentRecord>;
  private readonly plans: JsonMapStore<SkillMutationPlan>;
  private readonly transactions: JsonMapStore<SkillTransactionRecord>;

  constructor(options: SkillControlPlaneOptions) {
    this.homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
    this.sharedRoot = path.resolve(
      options.sharedRoot ?? path.join(this.homeDirectory, ".agents", "skills"),
    );
    this.disabledRoot = path.resolve(
      options.disabledRoot ?? path.join(this.homeDirectory, ".agents", "skills-disabled"),
    );
    this.targetRoots = options.targetRoots ?? {
      codex: path.join(this.homeDirectory, ".codex", "skills"),
      claude: path.join(this.homeDirectory, ".claude", "skills"),
      cursor: path.join(this.homeDirectory, ".cursor", "skills"),
      opencode: path.join(this.homeDirectory, ".config", "opencode", "skills"),
      pi: path.join(this.homeDirectory, ".pi", "agent", "skills"),
    };
    const stateDirectory = path.join(options.dataDir, "state", "skills");
    const sourcesPath = path.join(stateDirectory, "sources.json");
    migrateLegacyStateFile(path.join(options.dataDir, "skill-sources.json"), sourcesPath);
    this.sources = new JsonArrayStore<string>(sourcesPath);
    this.ownership = new JsonMapStore<SkillOwnershipRecord>(
      path.join(stateDirectory, "ownership.json"),
    );
    this.assignments = new JsonMapStore<SkillAssignmentRecord>(
      path.join(stateDirectory, "assignments.json"),
    );
    this.plans = new JsonMapStore<SkillMutationPlan>(path.join(stateDirectory, "plans.json"));
    this.transactions = new JsonMapStore<SkillTransactionRecord>(
      path.join(stateDirectory, "transactions.json"),
    );
    this.recoverPendingTransactions();
  }

  scan(): SkillCatalogSnapshot {
    const discovered = new Map<string, DiscoveredSkill>();
    this.collectRoot(this.sharedRoot, "shared", discovered);
    this.collectRoot(this.disabledRoot, "disabled", discovered);
    for (const source of this.sources.read()) {
      this.collectRoot(source, "adopted", discovered);
    }
    for (const agentId of SKILL_AGENT_IDS) {
      this.collectRoot(this.targetRoots[agentId], "agent_native", discovered);
    }

    const grouped = new Map<string, DiscoveredSkill[]>();
    for (const skill of discovered.values()) {
      const id = path.basename(skill.sourcePath);
      grouped.set(id, [...(grouped.get(id) ?? []), skill]);
    }
    const skills = [...grouped.entries()]
      .map(([id, candidates]) => this.toCatalogEntry(id, candidates))
      .sort((left, right) => left.name.localeCompare(right.name));
    const targets = SKILL_AGENT_IDS.map((agentId) => ({
      agent_id: agentId,
      display_name: TARGET_NAMES[agentId],
      root_path: agentId === "claude" ? this.targetRoots[agentId] : this.sharedRoot,
      delivery_mode: deliveryMode(agentId),
    }));
    const recoveryRequired = Object.values(this.transactions.read())
      .filter((transaction) => transaction.status === "failed").length;
    return {
      skills,
      targets,
      summary: {
        total: skills.length,
        sources: new Set(skills.map((skill) => skill.source_kind)).size,
        linked: skills.flatMap((skill) => skill.targets)
          .filter((target) => target.state === "linked" || target.state === "follows_global").length,
        issues: skills.filter((skill) => !skill.can_apply).length
          + skills.flatMap((skill) => skill.targets)
            .filter((target) => target.state === "conflict" || target.state === "broken").length
          + recoveryRequired,
        recovery_required: recoveryRequired,
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

  previewAdopt(input: { skill_id: string; actor_id: string }): SkillMutationPlan {
    const skill = this.findSkill(input.skill_id);
    this.assertPackageCanMutate(skill);
    if (skill.ownership === "native_managed") {
      throw new SkillControlPlaneError(
        "skill_adopt_forbidden",
        `Skill 由 Agent 或系统原生管理，不能 Adopt: ${skill.id}`,
      );
    }
    const alreadyShared = isPathInside(this.sharedRoot, skill.source_path)
      || isPathInside(this.disabledRoot, skill.source_path);
    const targetPath = alreadyShared ? skill.source_path : path.join(this.sharedRoot, skill.id);
    const targetOccupied = !alreadyShared && pathExists(targetPath);
    return this.createPlan({
      actorId: input.actor_id,
      kind: "adopt",
      skill,
      targetPath,
      canApply: !targetOccupied,
      detail: targetOccupied ? `共享目录已存在同名 Skill: ${targetPath}` : null,
      request: {},
      steps: alreadyShared
        ? [{ action: "set_ownership", detail: "原地登记为 CodeBridge 受管 Skill" }]
        : [
            { action: "move", source_path: skill.source_path, target_path: targetPath, detail: "移动到共享启用目录" },
            { action: "create_link", source_path: targetPath, target_path: skill.source_path, detail: "在原位置创建兼容软链" },
            { action: "set_ownership", detail: "登记 ownership 与 provenance" },
          ],
    });
  }

  previewAssignment(input: {
    skill_id: string;
    agent_id: SkillAgentId;
    enabled: boolean;
    actor_id: string;
  }): SkillMutationPlan {
    const skill = this.findSkill(input.skill_id);
    this.assertPackageCanMutate(skill);
    if (input.agent_id !== "claude") {
      throw new SkillControlPlaneError(
        "skill_target_unknown",
        `${TARGET_NAMES[input.agent_id] ?? input.agent_id} 直接读取共享目录，不支持独立分发开关`,
        400,
      );
    }
    const target = skill.targets.find((candidate) => candidate.agent_id === input.agent_id)!;
    const assignment = this.assignments.read()[assignmentKey(skill.id, input.agent_id)];
    if (!input.enabled && target.state !== "absent" && !this.ownsProjectedLink(skill, assignment)) {
      throw new SkillControlPlaneError(
        "skill_unlink_forbidden",
        `目标不是 CodeBridge 拥有的软链，禁止移除: ${target.target_path}`,
      );
    }
    if (skill.ownership !== "codebridge_managed") {
      throw new SkillControlPlaneError(
        "skill_adopt_forbidden",
        `Skill 必须先 Adopt 才能分发: ${skill.id}`,
      );
    }
    const canApply = input.enabled
      ? target.state === "absent" || target.state === "linked"
      : target.state === "absent" || target.state === "linked";
    const steps: SkillMutationStep[] = [];
    if (input.enabled && skill.global_state === "enabled" && target.state === "absent") {
      steps.push({ action: "create_link", source_path: skill.source_path, target_path: target.target_path, detail: "创建 Claude 兼容软链" });
    }
    if (!input.enabled && target.state === "linked") {
      steps.push({ action: "remove_link", source_path: skill.source_path, target_path: target.target_path, detail: "移除 CodeBridge-owned Claude 软链" });
    }
    steps.push({ action: "set_assignment", detail: `保存期望状态: ${input.enabled ? "linked" : "absent"}` });
    return this.createPlan({
      actorId: input.actor_id,
      kind: "assignment",
      skill,
      targetPath: target.target_path,
      canApply,
      detail: canApply ? null : target.detail,
      request: { enabled: input.enabled, agent_id: input.agent_id },
      steps,
    });
  }

  previewGlobalState(input: {
    skill_id: string;
    enabled: boolean;
    actor_id: string;
  }): SkillMutationPlan {
    const skill = this.findSkill(input.skill_id);
    this.assertPackageCanMutate(skill);
    if (skill.ownership !== "codebridge_managed") {
      throw new SkillControlPlaneError(
        "skill_adopt_forbidden",
        `Skill 必须先 Adopt 才能全局启停: ${skill.id}`,
      );
    }
    const targetPath = path.join(input.enabled ? this.sharedRoot : this.disabledRoot, skill.id);
    const alreadyDesired = input.enabled
      ? skill.global_state === "enabled"
      : skill.global_state === "disabled";
    const targetOccupied = !alreadyDesired && pathExists(targetPath);
    const steps: SkillMutationStep[] = [];
    if (!alreadyDesired) {
      if (!input.enabled) {
        steps.push({ action: "remove_link", detail: "暂停所有 CodeBridge-owned 适配软链" });
      }
      steps.push({ action: "move", source_path: skill.source_path, target_path: targetPath, detail: input.enabled ? "移回共享启用目录" : "移入可恢复停用目录" });
      if (input.enabled) {
        steps.push({ action: "create_link", detail: "恢复期望为 linked 的适配软链" });
      }
    }
    return this.createPlan({
      actorId: input.actor_id,
      kind: "global_state",
      skill,
      targetPath,
      canApply: !targetOccupied,
      detail: targetOccupied ? `目标目录已存在: ${targetPath}` : null,
      request: { enabled: input.enabled },
      steps,
    });
  }

  previewUnmanage(input: { skill_id: string; actor_id: string }): SkillMutationPlan {
    const skill = this.findSkill(input.skill_id);
    this.assertPackageCanMutate(skill);
    if (skill.ownership !== "codebridge_managed") {
      throw new SkillControlPlaneError("skill_adopt_forbidden", `Skill 当前未由 CodeBridge 管理: ${skill.id}`);
    }
    return this.createPlan({
      actorId: input.actor_id,
      kind: "unmanage",
      skill,
      targetPath: skill.source_path,
      canApply: true,
      detail: null,
      request: {},
      steps: [{ action: "set_ownership", detail: "取消纳管但保留内容和现有软链" }],
    });
  }

  applyPlan(input: { plan_id: string; actor_id: string }): SkillMutationResult {
    const plan = this.plans.read()[input.plan_id];
    if (!plan) {
      throw new SkillControlPlaneError("skill_plan_not_found", `Skill plan 不存在: ${input.plan_id}`, 404);
    }
    if (plan.actor_id !== input.actor_id) {
      throw new SkillControlPlaneError("skill_plan_actor_mismatch", "Skill plan 不属于当前 actor", 409);
    }
    if (Date.parse(plan.expires_at) <= Date.now()) {
      throw new SkillControlPlaneError("skill_plan_expired", "Skill plan 已过期，请重新预览", 409);
    }
    if (!plan.can_apply) {
      throw new SkillControlPlaneError("skill_target_conflict", plan.detail ?? "Skill plan 存在冲突", 409);
    }
    const skill = this.findSkill(plan.skill_id);
    if (skill.package_revision !== plan.package_revision) {
      throw new SkillControlPlaneError("skill_revision_mismatch", "Skill Package 在预览后发生变化", 409);
    }
    if (fingerprintPath(plan.source_path) !== plan.source_fingerprint) {
      throw new SkillControlPlaneError("skill_revision_mismatch", "Skill Source 在预览后发生变化", 409);
    }
    if (fingerprintPath(plan.target_path) !== plan.target_fingerprint) {
      throw new SkillControlPlaneError("skill_target_conflict", "Skill Target 在预览后发生变化", 409);
    }

    const transactionId = crypto.randomUUID();
    const now = new Date().toISOString();
    this.transactions.update((current) => ({
      ...current,
      [transactionId]: {
        transaction_id: transactionId,
        plan_id: plan.plan_id,
        kind: plan.kind,
        status: "pending",
        stage: "planned",
        created_at: now,
        updated_at: now,
      },
    }));
    try {
      this.executePlan(plan, transactionId);
      const snapshot = this.scan();
      this.updateTransaction(transactionId, { status: "completed", stage: "committed" });
      this.plans.update((current) => {
        const next = { ...current };
        delete next[plan.plan_id];
        return next;
      });
      return { plan_id: plan.plan_id, transaction_id: transactionId, snapshot };
    } catch (error) {
      this.updateTransaction(transactionId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private createPlan(input: {
    actorId: string;
    kind: SkillMutationKind;
    skill: SkillCatalogEntry;
    targetPath: string;
    canApply: boolean;
    detail: string | null;
    request: SkillMutationPlan["request"];
    steps: SkillMutationStep[];
  }): SkillMutationPlan {
    const plan: SkillMutationPlan = {
      plan_id: crypto.randomUUID(),
      actor_id: input.actorId,
      kind: input.kind,
      skill_id: input.skill.id,
      package_revision: input.skill.package_revision,
      source_path: input.skill.source_path,
      target_path: input.targetPath,
      source_fingerprint: fingerprintPath(input.skill.source_path),
      target_fingerprint: fingerprintPath(input.targetPath),
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      steps: input.steps,
      can_apply: input.canApply,
      detail: input.detail,
      request: input.request,
    };
    this.plans.update((current) => ({ ...current, [plan.plan_id]: plan }));
    return plan;
  }

  private assertPackageCanMutate(skill: SkillCatalogEntry): void {
    if (skill.global_state === "split_brain") {
      throw new SkillControlPlaneError("skill_split_brain", `Skill 同时存在于启用和停用目录: ${skill.id}`);
    }
    if (skill.global_state === "invalid") {
      const code = skill.name === skill.id ? "skill_package_invalid" : "skill_identity_mismatch";
      throw new SkillControlPlaneError(code, `Skill Package 身份或内容无效: ${skill.id}`, 422);
    }
    if (!skill.can_apply) {
      throw new SkillControlPlaneError("skill_target_conflict", `Skill 存在同名不同内容的 Source: ${skill.id}`);
    }
  }

  private executePlan(plan: SkillMutationPlan, transactionId: string): void {
    if (plan.kind === "adopt") {
      this.executeAdopt(plan, transactionId);
      return;
    }
    if (plan.kind === "assignment") {
      this.executeAssignment(plan, transactionId);
      return;
    }
    if (plan.kind === "global_state") {
      this.executeGlobalState(plan, transactionId);
      return;
    }
    this.ownership.update((current) => {
      const next = { ...current };
      delete next[plan.skill_id];
      return next;
    });
    this.assignments.update((current) => {
      const next = { ...current };
      for (const key of Object.keys(next)) {
        if (next[key]?.skill_id === plan.skill_id) delete next[key];
      }
      return next;
    });
    this.updateTransaction(transactionId, { stage: "verified" });
  }

  private recoverPendingTransactions(): void {
    const transactions = this.transactions.read();
    const plans = this.plans.read();
    for (const transaction of Object.values(transactions)) {
      if (transaction.status !== "pending") continue;
      const plan = plans[transaction.plan_id];
      if (!plan) {
        this.updateTransaction(transaction.transaction_id, {
          status: "failed",
          error: "持久事务缺少原始 plan，必须人工恢复",
        });
        continue;
      }
      try {
        this.executePlan(plan, transaction.transaction_id);
        this.scan();
        this.updateTransaction(transaction.transaction_id, {
          status: "completed",
          stage: "committed",
        });
        this.plans.update((current) => {
          const next = { ...current };
          delete next[plan.plan_id];
          return next;
        });
      } catch (error) {
        this.updateTransaction(transaction.transaction_id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private executeAdopt(plan: SkillMutationPlan, transactionId: string): void {
    let managedPath = plan.source_path;
    if (plan.source_path !== plan.target_path) {
      fs.mkdirSync(path.dirname(plan.target_path), { recursive: true });
      if (pathExists(plan.source_path) && !pathExistsLstat(plan.target_path)) {
        fs.renameSync(plan.source_path, plan.target_path);
        this.updateTransaction(transactionId, { stage: "source_switched" });
      } else if (!pathExistsLstat(plan.target_path)) {
        throw new SkillControlPlaneError("skill_transaction_recovery_required", "Adopt Source 和 Target 都不存在");
      }
      if (!pathExistsLstat(plan.source_path)) {
        fs.symlinkSync(plan.target_path, plan.source_path, "dir");
      } else if (!this.isManagedLink(plan.source_path, plan.target_path)) {
        throw new SkillControlPlaneError("skill_transaction_recovery_required", "Adopt 原位置已被其他内容占用");
      }
      managedPath = plan.target_path;
      this.updateTransaction(transactionId, { stage: "links_reconciled" });
    }
    const now = new Date().toISOString();
    this.ownership.update((current) => ({
      ...current,
      [plan.skill_id]: {
        ownership: "codebridge_managed",
        source_path: managedPath,
        adopted_at: now,
        last_observed_revision: plan.package_revision,
      },
    }));
    this.updateTransaction(transactionId, { stage: "verified" });
  }

  private executeAssignment(plan: SkillMutationPlan, transactionId: string): void {
    const enabled = plan.request.enabled === true;
    const agentId = plan.request.agent_id;
    if (agentId !== "claude") {
      throw new SkillControlPlaneError("skill_target_unknown", "只有 symlink_projection Agent 可以保存 Assignment", 400);
    }
    const skill = this.findSkill(plan.skill_id);
    const key = assignmentKey(skill.id, agentId);
    const existing = this.assignments.read()[key];
    if (enabled && skill.global_state === "enabled" && !pathExistsLstat(plan.target_path)) {
      fs.mkdirSync(path.dirname(plan.target_path), { recursive: true });
      fs.symlinkSync(skill.source_path, plan.target_path, "dir");
    } else if (enabled && skill.global_state === "enabled" && !this.isManagedLink(plan.target_path, skill.source_path)) {
      throw new SkillControlPlaneError("skill_target_conflict", `Claude Target 已被其他内容占用: ${plan.target_path}`);
    }
    if (!enabled && pathExistsLstat(plan.target_path)) {
      if (!this.ownsProjectedLink(skill, existing)) {
        throw new SkillControlPlaneError("skill_unlink_forbidden", `禁止移除非受管软链: ${plan.target_path}`);
      }
      fs.unlinkSync(plan.target_path);
    }
    const now = new Date().toISOString();
    this.assignments.update((current) => ({
      ...current,
      [key]: {
        skill_id: skill.id,
        agent_id: agentId,
        desired_state: enabled ? "linked" : "absent",
        target_path: plan.target_path,
        created_link_target: enabled ? skill.source_path : existing?.created_link_target,
        last_applied_package_revision: skill.package_revision,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      },
    }));
    this.updateTransaction(transactionId, { stage: "links_reconciled" });
  }

  private executeGlobalState(plan: SkillMutationPlan, transactionId: string): void {
    const enabled = plan.request.enabled === true;
    const skill = this.findSkill(plan.skill_id);
    const assignment = this.assignments.read()[assignmentKey(skill.id, "claude")];
    const claudeTarget = path.join(this.targetRoots.claude, skill.id);
    if (!enabled && assignment?.desired_state === "linked" && pathExistsLstat(claudeTarget)) {
      if (!this.ownsProjectedLink(skill, assignment)) {
        throw new SkillControlPlaneError("skill_unlink_forbidden", `Claude Target 已脱离 CodeBridge 管理: ${claudeTarget}`);
      }
      fs.unlinkSync(claudeTarget);
      this.updateTransaction(transactionId, { stage: "links_reconciled" });
    }
    if (plan.source_path !== plan.target_path) {
      fs.mkdirSync(path.dirname(plan.target_path), { recursive: true });
      if (pathExists(plan.source_path) && !pathExistsLstat(plan.target_path)) {
        fs.renameSync(plan.source_path, plan.target_path);
        this.updateTransaction(transactionId, { stage: "source_switched" });
      } else if (!pathExists(plan.target_path)) {
        throw new SkillControlPlaneError("skill_transaction_recovery_required", "全局状态 Source 和 Target 都不存在");
      }
    }
    if (enabled && assignment?.desired_state === "linked") {
      if (pathExistsLstat(claudeTarget)) {
        throw new SkillControlPlaneError("skill_target_conflict", `Claude Target 已被占用: ${claudeTarget}`);
      }
      fs.mkdirSync(path.dirname(claudeTarget), { recursive: true });
      fs.symlinkSync(plan.target_path, claudeTarget, "dir");
      this.updateTransaction(transactionId, { stage: "links_reconciled" });
    }
    const ownership = this.ownership.read()[skill.id];
    if (ownership) {
      this.ownership.update((current) => ({
        ...current,
        [skill.id]: { ...ownership, source_path: plan.target_path },
      }));
    }
    this.updateTransaction(transactionId, { stage: "verified" });
  }

  private ownsProjectedLink(
    skill: SkillCatalogEntry,
    assignment: SkillAssignmentRecord | undefined,
  ): boolean {
    if (!assignment || assignment.desired_state !== "linked") return false;
    return assignment.target_path === path.join(this.targetRoots[assignment.agent_id], skill.id)
      && assignment.created_link_target === skill.source_path
      && this.isManagedLink(assignment.target_path, skill.source_path);
  }

  private updateTransaction(
    transactionId: string,
    patch: Partial<Pick<SkillTransactionRecord, "status" | "stage" | "error">>,
  ): void {
    this.transactions.update((current) => {
      const transaction = current[transactionId];
      if (!transaction) return current;
      return {
        ...current,
        [transactionId]: {
          ...transaction,
          ...patch,
          updated_at: new Date().toISOString(),
        },
      };
    });
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

  private toCatalogEntry(id: string, candidates: DiscoveredSkill[]): SkillCatalogEntry {
    const sorted = [...candidates].sort(
      (left, right) => SOURCE_PRIORITY[right.sourceKind] - SOURCE_PRIORITY[left.sourceKind],
    );
    const discovered = sorted[0]!;
    const skillFile = path.join(discovered.sourcePath, "SKILL.md");
    const content = fs.readFileSync(skillFile, "utf8");
    const metadata = parseSkillMetadata(content, id);
    const packageFingerprint = fingerprintSkillPackage(discovered.sourcePath);
    const candidateRevisions = new Set(
      candidates.map((candidate) => fingerprintSkillPackage(candidate.sourcePath).revision),
    );
    const hasSourceConflict = candidates.length > 1
      && candidateRevisions.size > 1
      && !(candidates.length === 2
        && candidates.some((candidate) => candidate.sourceKind === "shared")
        && candidates.some((candidate) => candidate.sourceKind === "disabled"));
    const hasActive = candidates.some((candidate) => candidate.sourceKind === "shared");
    const hasDisabled = candidates.some((candidate) => candidate.sourceKind === "disabled");
    const identityValid = metadata.name === id;
    const globalState: SkillGlobalState = !identityValid || !packageFingerprint.valid
      ? "invalid"
      : hasActive && hasDisabled
        ? "split_brain"
        : hasActive
          ? "enabled"
          : hasDisabled
            ? "disabled"
            : "external";
    const revision = packageFingerprint.revision;
    const ownershipRecord = this.ownership.read()[id];
    const ownership = ownershipRecord?.last_observed_revision === revision
      || ownershipRecord?.ownership === "codebridge_managed"
      ? ownershipRecord.ownership
      : "external_observed";
    return {
      id,
      name: metadata.name,
      description: metadata.description,
      source_path: discovered.sourcePath,
      source_kind: discovered.sourceKind,
      package_revision: revision,
      revision,
      global_state: globalState,
      ownership,
      can_apply: globalState !== "invalid" && globalState !== "split_brain" && !hasSourceConflict,
      tags: metadata.tags,
      updated_at: fs.statSync(skillFile).mtime.toISOString(),
      targets: SKILL_AGENT_IDS.map((agentId) => (
        agentId === "claude"
          ? this.inspectTarget(discovered.sourcePath, agentId)
          : {
              agent_id: agentId,
              delivery_mode: "shared_native" as const,
              target_path: path.join(this.sharedRoot, id),
              state: "follows_global" as const,
              mutable: false,
              detail: globalState === "enabled"
                ? "Agent 直接读取共享启用目录"
                : "Agent 跟随 Skill 全局状态",
            }
      )),
    };
  }

  private inspectTarget(sourcePath: string, agentId: SkillAgentId): SkillTargetView {
    const targetPath = path.join(this.targetRoots[agentId], path.basename(sourcePath));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(targetPath);
    } catch {
      return {
        agent_id: agentId,
        delivery_mode: deliveryMode(agentId),
        target_path: targetPath,
        state: "absent",
        mutable: agentId === "claude",
        detail: null,
      };
    }
    let resolvedTarget: string | null = null;
    try {
      resolvedTarget = fs.realpathSync(targetPath);
    } catch {
      resolvedTarget = null;
    }
    if (stat.isSymbolicLink()) {
      if (!resolvedTarget) {
        return {
          agent_id: agentId,
          delivery_mode: deliveryMode(agentId),
          target_path: targetPath,
          state: "broken",
          mutable: agentId === "claude",
          detail: "Target 是无法解析的软链",
        };
      }
      if (resolvedTarget === sourcePath && this.resolveSkillDirectory(targetPath)) {
        return {
          agent_id: agentId,
          delivery_mode: deliveryMode(agentId),
          target_path: targetPath,
          state: "linked",
          mutable: agentId === "claude",
          detail: "目标目录可见且 SKILL.md 可读",
        };
      }
      return {
        agent_id: agentId,
        delivery_mode: deliveryMode(agentId),
        target_path: targetPath,
        state: "conflict",
        mutable: agentId === "claude",
        detail: `Target 已指向其他 Source: ${resolvedTarget}`,
      };
    }
    return {
      agent_id: agentId,
      delivery_mode: deliveryMode(agentId),
      target_path: targetPath,
      state: "conflict",
      mutable: agentId === "claude",
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

function deliveryMode(agentId: SkillAgentId): SkillDeliveryMode {
  return agentId === "claude" ? "symlink_projection" : "shared_native";
}

function assignmentKey(skillId: string, agentId: SkillAgentId): string {
  return `${skillId}:${agentId}`;
}

function pathExists(candidate: string): boolean {
  try {
    fs.statSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function pathExistsLstat(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = canonicalPath(root);
  const normalizedCandidate = canonicalPath(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function canonicalPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function migrateLegacyStateFile(legacyPath: string, targetPath: string): void {
  if (pathExistsLstat(targetPath) || !pathExists(legacyPath)) return;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
}

function fingerprintPath(candidate: string): string {
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      let resolved = "broken";
      try {
        resolved = fs.realpathSync(candidate);
      } catch {
        // Broken links must still have a stable fingerprint.
      }
      return `symlink:${fs.readlinkSync(candidate)}:${resolved}`;
    }
    if (stat.isDirectory()) {
      const packageFingerprint = fingerprintSkillPackage(candidate);
      return `directory:${packageFingerprint.valid}:${packageFingerprint.revision}`;
    }
    if (stat.isFile()) {
      return `file:${stat.mode & 0o111}:${crypto.createHash("sha256").update(fs.readFileSync(candidate)).digest("hex")}`;
    }
    return `special:${stat.mode}`;
  } catch {
    return "absent";
  }
}

function fingerprintSkillPackage(root: string): { revision: string; valid: boolean } {
  const hash = crypto.createHash("sha256");
  let valid = true;
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        hash.update(`directory\0${relative}\0${stat.mode & 0o111}\0`);
        visit(absolute);
        continue;
      }
      if (stat.isFile()) {
        hash.update(`file\0${relative}\0${stat.mode & 0o111}\0`);
        hash.update(fs.readFileSync(absolute));
        hash.update("\0");
        continue;
      }
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        const resolved = path.resolve(path.dirname(absolute), target);
        const relativeTarget = path.relative(root, resolved);
        if (path.isAbsolute(target) || relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`)) {
          valid = false;
        }
        hash.update(`symlink\0${relative}\0${target}\0`);
        continue;
      }
      valid = false;
      hash.update(`special\0${relative}\0`);
    }
  };
  visit(root);
  return { revision: hash.digest("hex"), valid };
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
