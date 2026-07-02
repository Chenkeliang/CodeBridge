import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface CliSessionSummary {
  id: string;
  backend: string;
  cwd: string;
  preview: string;
  updatedAt: string;
}

/** Claude Code: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl */
export function encodeClaudeProjectDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  return resolved.replace(/\//g, "-");
}

function cwdUnderScope(sessionCwd: string, scopeCwd: string): boolean {
  const session = path.resolve(sessionCwd);
  const scope = path.resolve(scopeCwd);
  return session === scope || session.startsWith(scope + path.sep);
}

function readClaudeSessionCwd(file: string): string | undefined {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").slice(0, 40);
    for (const line of lines) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line) as { cwd?: string };
      if (typeof obj.cwd === "string" && obj.cwd.trim()) {
        return obj.cwd;
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function listClaudeSessions(
  cwd: string,
  limit = 20,
  all = false,
): CliSessionSummary[] {
  const home = os.homedir();
  const projectsRoot = path.join(home, ".claude", "projects");
  if (!fs.existsSync(projectsRoot)) return [];

  const scope = path.resolve(cwd);
  const sessions: CliSessionSummary[] = [];

  for (const projectName of fs.readdirSync(projectsRoot)) {
    const projectDir = path.join(projectsRoot, projectName);
    if (!fs.statSync(projectDir).isDirectory()) continue;

    for (const name of fs.readdirSync(projectDir)) {
      if (!name.endsWith(".jsonl") || name.includes("/")) continue;
      const file = path.join(projectDir, name);
      const sessionCwd = readClaudeSessionCwd(file);
      if (!all) {
        if (!sessionCwd || !cwdUnderScope(sessionCwd, scope)) continue;
      }
      const stat = fs.statSync(file);
      sessions.push({
        id: path.basename(name, ".jsonl"),
        backend: "claude",
        cwd: sessionCwd ? path.resolve(sessionCwd) : scope,
        preview: readClaudePreview(file),
        updatedAt: stat.mtime.toISOString(),
      });
    }
  }

  return sortAndLimit(sessions, limit);
}

function isNoisePreview(text: string): boolean {
  const t = text.trim();
  if (!t || t === "(no preview)") return true;
  if (/^\d+$/.test(t)) return true;
  if (t.startsWith("Caveat: The messages below")) return true;
  if (t.startsWith("<local-command")) return true;
  return false;
}

function readClaudePreview(file: string): string {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").slice(0, 80);
    for (const line of lines) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: string | unknown[] };
      };
      if (obj.type !== "user" && obj.message?.role !== "user") continue;
      const content = obj.message?.content;
      if (typeof content === "string") {
        const text = truncate(stripTags(content));
        if (!isNoisePreview(text)) return text;
        continue;
      }
      if (Array.isArray(content)) {
        for (const part of content) {
          if (
            typeof part === "object" &&
            part !== null &&
            "text" in part &&
            typeof (part as { text: string }).text === "string"
          ) {
            const text = stripTags((part as { text: string }).text);
            if (!isNoisePreview(text)) {
              return truncate(text);
            }
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return "(no preview)";
}

// Codex sessions: ~/.codex/sessions/.../rollout-*.jsonl
export function listCodexSessions(
  cwd: string,
  limit = 20,
  all = false,
): CliSessionSummary[] {
  const home = os.homedir();
  const root = path.join(home, ".codex", "sessions");
  if (!fs.existsSync(root)) return [];

  const resolved = path.resolve(cwd);
  const sessions: CliSessionSummary[] = [];
  walkCodexSessions(root, (file) => {
    const meta = readCodexMeta(file);
    if (!meta) return;
    if (!all && meta.cwd && !cwdUnderScope(meta.cwd, resolved)) return;
    const stat = fs.statSync(file);
    sessions.push({
      id: meta.id,
      backend: "codex",
      cwd: meta.cwd ?? resolved,
      preview: meta.preview,
      updatedAt: stat.mtime.toISOString(),
    });
  });

  return sortAndLimit(sessions, limit);
}

function walkCodexSessions(
  dir: string,
  onFile: (file: string) => void,
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCodexSessions(full, onFile);
    } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      onFile(full);
    }
  }
}

function readCodexMeta(
  file: string,
): { id: string; cwd?: string; preview: string } | null {
  try {
    const first = fs.readFileSync(file, "utf8").split("\n")[0];
    if (!first) return null;
    const line = JSON.parse(first) as {
      type?: string;
      payload?: {
        id?: string;
        cwd?: string;
      };
    };
    let id = line.payload?.id;
    let cwd = line.payload?.cwd;
    let preview = "(no preview)";

    const content = fs.readFileSync(file, "utf8").split("\n").slice(0, 30);
    for (const row of content) {
      if (!row.trim()) continue;
      const obj = JSON.parse(row) as {
        type?: string;
        payload?: {
          type?: string;
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
          cwd?: string;
          id?: string;
        };
      };
      if (obj.type === "session_meta" && obj.payload?.id) {
        id = obj.payload.id;
        cwd = obj.payload.cwd ?? cwd;
      }
      const payload = obj.payload;
      if (
        payload?.type === "message" &&
        payload.role === "user" &&
        Array.isArray(payload.content)
      ) {
        for (const c of payload.content) {
          if (c.type === "input_text" && c.text && !c.text.startsWith("# AGENTS")) {
            preview = truncate(c.text);
            break;
          }
        }
      }
    }

    if (!id) {
      const match = path.basename(file).match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      );
      id = match?.[1];
    }
    if (!id) return null;
    return { id, cwd, preview };
  } catch {
    return null;
  }
}

/** Cursor agent: ~/.cursor/projects/<encoded-project>/agent-transcripts/<id>/<id>.jsonl */
export function encodeCursorProjectDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  const trimmed = resolved.startsWith(path.sep) ? resolved.slice(1) : resolved;
  return trimmed.replace(/[/.]/g, "-");
}

function approximateCursorProjectCwd(projectName: string): string {
  return path.sep + projectName.replace(/-/g, path.sep);
}

function cursorProjectDirUnderScope(projectName: string, scopeCwd: string): boolean {
  const encoded = encodeCursorProjectDir(scopeCwd);
  return projectName === encoded || projectName.startsWith(`${encoded}-`);
}

export function listCursorSessions(
  cwd: string,
  _command = "agent",
  limit = 20,
  all = false,
): CliSessionSummary[] {
  const home = os.homedir();
  const projectsRoot = path.join(home, ".cursor", "projects");
  if (!fs.existsSync(projectsRoot)) return [];

  const scope = path.resolve(cwd);
  const sessions: CliSessionSummary[] = [];

  for (const projectName of fs.readdirSync(projectsRoot)) {
    const projectDir = path.join(projectsRoot, projectName);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    if (!all && !cursorProjectDirUnderScope(projectName, scope)) continue;

    const transcriptsRoot = path.join(projectDir, "agent-transcripts");
    if (!fs.existsSync(transcriptsRoot)) continue;

    for (const sessionId of fs.readdirSync(transcriptsRoot)) {
      if (sessionId === "subagents") continue;
      const sessionDir = path.join(transcriptsRoot, sessionId);
      if (!fs.statSync(sessionDir).isDirectory()) continue;

      const file = path.join(sessionDir, `${sessionId}.jsonl`);
      if (!fs.existsSync(file)) continue;

      const stat = fs.statSync(file);
      sessions.push({
        id: sessionId,
        backend: "cursor",
        cwd: approximateCursorProjectCwd(projectName),
        preview: readCursorPreview(file),
        updatedAt: stat.mtime.toISOString(),
      });
    }
  }

  return sortAndLimit(sessions, limit);
}

function readCursorPreview(file: string): string {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").slice(0, 40);
    for (const line of lines) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line) as {
        role?: string;
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      };
      if (obj.role !== "user") continue;
      const content = obj.message?.content;
      if (typeof content === "string") {
        const text = stripTags(content);
        if (!isNoisePreview(text)) return truncate(text);
        continue;
      }
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "text" && part.text) {
            const text = stripTags(part.text)
              .replace(/^<user_query>\s*/i, "")
              .replace(/\s*<\/user_query>$/i, "");
            if (!isNoisePreview(text)) {
              return truncate(text);
            }
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return "(no preview)";
}

export function listSessionsForBackend(
  backend: string,
  cwd: string,
  options?: { limit?: number; all?: boolean; cursorCommand?: string },
): CliSessionSummary[] {
  const limit = options?.limit ?? 20;
  const all = options?.all ?? false;
  switch (backend) {
    case "claude":
      return listClaudeSessions(cwd, limit, all);
    case "codex":
      return listCodexSessions(cwd, limit, all);
    case "cursor":
      return listCursorSessions(
        cwd,
        options?.cursorCommand ?? "agent",
        limit,
        all,
      );
    default:
      return [];
  }
}

function sortAndLimit(
  sessions: CliSessionSummary[],
  limit: number,
): CliSessionSummary[] {
  return sessions
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

function truncate(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").trim();
}
