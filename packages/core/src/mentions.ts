import { JsonMapStore } from "./json-file-store.js";

export type MentionTargetKind = "user" | "bot";

export interface MentionScope {
  chatId: string;
  topicId?: string;
}

export interface MentionTarget {
  channel: string;
  kind: MentionTargetKind;
  id: string;
  name?: string;
  username?: string;
}

export interface RegisteredMentionTarget extends MentionTarget {
  ref: string;
}

/** Canonical names for an explicitly selected group notification; IDs are resolved by the backend. */
export function normalizeNotificationNames(value: unknown): string | string[] | undefined {
  if (value === undefined) return undefined;
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || !values.length || values.length > 20 || values.some(name => typeof name !== "string"
    || !name.trim() || name.length > 100 || /[\x00-\x1f<>@]/u.test(name) || /^(?:ou|on|oc|om|cli)_/.test(name.trim()))) {
    throw new Error("notify must contain 1–20 group member names, not IDs or mention markup");
  }
  const names = [...new Set(values.map((name: string) => name.trim()))].sort();
  return names.length === 1 ? names[0] : names;
}

export function normalizeMentionRefs(value: unknown): string[] {
  const refs = typeof value === "string" ? [value] : value;
  if (!Array.isArray(refs) || !refs.length || refs.length > 20 || refs.some(ref => typeof ref !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(ref))) {
    throw new Error("mention needs 1–20 references registered in the current conversation");
  }
  return [...new Set(refs)];
}

interface StoredMentionTarget {
  target: RegisteredMentionTarget;
  scopes: string[];
}

function scopeKey(scope: MentionScope): string {
  return `${scope.chatId}\0${scope.topicId ?? ""}`;
}

function targetKey(target: MentionTarget): string {
  return `${target.channel}\0${target.kind}\0${target.id}`;
}

export class MentionRegistry {
  private readonly targetByKey = new Map<string, RegisteredMentionTarget>();
  private readonly targetByRef = new Map<string, RegisteredMentionTarget>();
  private readonly refsByScope = new Map<string, Set<string>>();
  private nextUserRef = 1;
  private nextBotRef = 1;
  private readonly store?: JsonMapStore<StoredMentionTarget>;

  constructor(filePath?: string) {
    if (!filePath) return;
    this.store = new JsonMapStore<StoredMentionTarget>(filePath);
    const saved = this.store.read();
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
      throw new Error("Invalid persisted mention registry");
    }
    for (const [ref, entry] of Object.entries(saved)) {
      const target = entry?.target;
      const ordinal = Number(ref.slice(1));
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(ref) || !Number.isSafeInteger(ordinal + 1)
        || !target || target.ref !== ref
        || target.kind !== (ref[0] === "u" ? "user" : "bot")
        || typeof target.id !== "string" || !target.id
        || typeof target.channel !== "string" || !target.channel
        || !Array.isArray(entry.scopes)
        || entry.scopes.some((scope) => typeof scope !== "string" || !scope.includes("\0"))
        || this.targetByKey.has(targetKey(target))) {
        throw new Error("Invalid persisted mention registry");
      }
      this.targetByKey.set(targetKey(target), target);
      this.targetByRef.set(ref, target);
      for (const scope of entry.scopes) {
        const refs = this.refsByScope.get(scope) ?? new Set<string>();
        refs.add(ref);
        this.refsByScope.set(scope, refs);
      }
      if (target.kind === "user") this.nextUserRef = Math.max(this.nextUserRef, ordinal + 1);
      else this.nextBotRef = Math.max(this.nextBotRef, ordinal + 1);
    }
  }

  register(
    scope: MentionScope,
    target: MentionTarget,
  ): RegisteredMentionTarget {
    const key = targetKey(target);
    const previous = this.targetByKey.get(key);
    const registered: RegisteredMentionTarget = previous
      ? {
          ...previous,
          ...target,
          name: target.name ?? previous.name,
          username: target.username ?? previous.username,
        }
      : {
          ...target,
          ref:
            target.kind === "bot"
              ? `b${this.nextBotRef++}`
              : `u${this.nextUserRef++}`,
        };
    this.targetByKey.set(key, registered);
    this.targetByRef.set(registered.ref, registered);

    const scoped = this.refsByScope.get(scopeKey(scope)) ?? new Set<string>();
    scoped.add(registered.ref);
    this.refsByScope.set(scopeKey(scope), scoped);
    this.save();
    return registered;
  }

  /** Drop stored names that are really labels (e.g. a role written by an older version). Returns how many were cleared. */
  forgetNames(names: readonly string[]): number {
    let cleared = 0;
    for (const [ref, target] of this.targetByRef) {
      if (target.name === undefined || !names.includes(target.name)) continue;
      const { name: _dropped, ...rest } = target;
      this.targetByRef.set(ref, rest);
      this.targetByKey.set(targetKey(rest), rest);
      cleared += 1;
    }
    if (cleared) this.save();
    return cleared;
  }

  private save(): void {
    if (!this.store) return;
    const saved: Record<string, StoredMentionTarget> = {};
    for (const [ref, target] of this.targetByRef) saved[ref] = { target, scopes: [] };
    for (const [key, refs] of this.refsByScope) {
      for (const ref of refs) saved[ref]!.scopes.push(key);
    }
    this.store.write(saved);
  }

  resolve(
    scope: MentionScope,
    ref: string,
  ): RegisteredMentionTarget | undefined {
    if (!this.refsByScope.get(scopeKey(scope))?.has(ref)) return undefined;
    return this.targetByRef.get(ref);
  }

  list(scope: MentionScope): RegisteredMentionTarget[] {
    return [...(this.refsByScope.get(scopeKey(scope)) ?? [])]
      .map((ref) => this.targetByRef.get(ref))
      .filter((target): target is RegisteredMentionTarget => Boolean(target));
  }
}

/**
 * `roles` labels a target for this prompt only (e.g. an alert approver).
 * Roles are never stored as the target's name: the registry is shared across chats.
 */
export function formatMentionGuidance(
  targets: RegisteredMentionTarget[],
  requesterRef?: string,
  roles: Record<string, string> = {},
): string {
  if (targets.length === 0) return "";
  const lines = targets.map((target) => {
    const label =
      target.name ??
      target.username ??
      (target.ref === requesterRef ? "当前发送者" : target.id);
    const role =
      roles[target.ref] !== undefined
        ? `（${roles[target.ref]}）`
        : target.ref === requesterRef
          ? "（当前发送者）"
          : target.kind === "bot"
            ? "（机器人）"
            : "";
    return `- ${target.ref}：${label}${role}`;
  });
  return [
    "【可主动通知对象】",
    ...lines,
    '需要主动提醒其中某个对象时，执行 `fcb mention <对象引用> "<消息>"`。',
    '按本次情况需要同时提醒多位已列出的对象时，引用以逗号分隔，例如 `fcb mention u1,u2 "<消息>"`，会在同一条消息中一次@；告警状态提醒优先用codebridge_alert_status在原回复卡片更新，不重复发送。',
    "仅在确实需要主动通知时使用；普通回复不要调用，也不要自行猜测对象引用。",
  ].join("\n");
}
