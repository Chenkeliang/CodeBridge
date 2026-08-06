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
    return registered;
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

export function formatMentionGuidance(
  targets: RegisteredMentionTarget[],
  requesterRef?: string,
): string {
  if (targets.length === 0) return "";
  const lines = targets.map((target) => {
    const label =
      target.name ??
      target.username ??
      (target.ref === requesterRef ? "当前发送者" : target.id);
    const role =
      target.ref === requesterRef
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
    "仅在确实需要主动通知时使用；普通回复不要调用，也不要自行猜测对象引用。",
  ].join("\n");
}
