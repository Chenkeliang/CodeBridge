import { Cron } from "croner";
import type { AgentTaskSchedule } from "@codebridge/core";

function cron(expression: string, timezone: string): Cron {
  return new Cron(expression, { timezone, mode: "5-part", paused: true });
}

/** Natural forms are deliberately bounded; every accepted form has an exact preview. */
export function parseTaskSchedule(input: string, timezone: string, now = new Date()): AgentTaskSchedule {
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now);
  const text = input.trim().replace(/：/g, ":");
  const duration = /^(?:(every|in)\s*|每)?(\d+)\s*(m|min|分钟|h|hour|小时|d|day|天)(后)?$/i.exec(text);
  if (duration) {
    const minutes = Number(duration[2]) * (/^(h|hour|小时)$/i.test(duration[3]!) ? 60 : /^(d|day|天)$/i.test(duration[3]!) ? 1440 : 1);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 525600) throw new Error("间隔须为1分钟至365天");
    if (duration[1]?.toLowerCase() === "in" || duration[4]) return { kind: "once", at: new Date(now.getTime() + minutes * 60_000).toISOString(), label: `${minutes}分钟后，仅一次` };
    return { kind: "interval", minutes, label: `每${minutes}分钟` };
  }
  const daily = /^(?:每天|每日|工作日|每个工作日|daily|weekdays)(?:\s+at)?\s*(\d{1,2})(?:[:点时](\d{1,2})?)?(?:分)?$/i.exec(text);
  const weekly = /^每周([一二三四五六日天])\s*(\d{1,2})(?:[:点时](\d{1,2})?)?(?:分)?$/.exec(text);
  let expression = text;
  if (daily || weekly) {
    const hour = Number((daily ?? weekly)![daily ? 1 : 2]), minute = Number((daily ?? weekly)![daily ? 2 : 3] ?? 0);
    if (hour > 23 || minute > 59) throw new Error("时间应在00:00至23:59之间");
    const weekday = weekly ? String("日一二三四五六天".indexOf(weekly[1]!) % 7) : /工作日|weekdays/i.test(text) ? "1-5" : "*";
    expression = `${minute} ${hour} * * ${weekday}`;
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
    const at = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
      ? new Date(text)
      : new Cron(text.replace(" ", "T"), { timezone, paused: true }).getOnce();
    if (!at || !Number.isFinite(at.getTime()) || at.getTime() <= now.getTime()) throw new Error("一次性执行时间须在未来，并明确时区");
    return { kind: "once", at: at.toISOString(), label: `仅一次：${text}` };
  }
  if (expression.split(/\s+/).length !== 5) throw new Error("计划格式不识别。可填“每天09:00”“工作日09:30”“每30分钟”“30分钟后”、ISO时间或五段Cron");
  try {
    const parsed = cron(expression, timezone);
    if (!parsed.nextRun(now)) throw new Error("计划没有未来执行时间");
    return { kind: "cron", expression, label: daily || weekly ? text : `Cron：${expression}` };
  } catch { throw new Error("Cron或日历时间无效，请检查五段表达式和日期范围"); }
}

export function nextTaskRun(schedule: AgentTaskSchedule, timezone: string, after: Date): string | null {
  if (schedule.kind === "once") return new Date(schedule.at) > after ? schedule.at : null;
  if (schedule.kind === "interval") return new Date(after.getTime() + schedule.minutes * 60_000).toISOString();
  return cron(schedule.expression, timezone).nextRun(after)?.toISOString() ?? null;
}

export function previewTaskSchedule(schedule: AgentTaskSchedule, timezone: string, now: Date): string[] {
  const result: string[] = [];
  let cursor = now;
  for (let i = 0; i < 3; i++) {
    const next = nextTaskRun(schedule, timezone, cursor);
    if (!next) break;
    result.push(next); cursor = new Date(next);
  }
  return result;
}
