import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeClaudeProjectDir,
  encodeCursorProjectDir,
  listClaudeSessions,
  listCodexSessions,
  listCursorSessions,
} from "./session-discovery.js";

const tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-sess-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("encodeClaudeProjectDir", () => {
  it("encodes cwd like Claude Code", () => {
    expect(encodeClaudeProjectDir("/Users/dev/proj")).toBe("-Users-dev-proj");
  });
});

describe("encodeCursorProjectDir", () => {
  it("encodes cwd like cursor-agent project dirs", () => {
    expect(encodeCursorProjectDir("/Users/dev/proj")).toBe("Users-dev-proj");
    expect(encodeCursorProjectDir("/Users/dev/a.b/c")).toBe("Users-dev-a-b-c");
  });
});

describe("listClaudeSessions", () => {
  it("reads sessions from project dir", () => {
    const home = mkTmp();
    const cwd = "/tmp/my-app";
    const projectDir = path.join(
      home,
      ".claude",
      "projects",
      encodeClaudeProjectDir(cwd),
    );
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionFile = path.join(projectDir, "sess-uuid.jsonl");
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "user",
          cwd,
          message: { role: "user", content: "fix the login bug" },
        }),
        JSON.stringify({ type: "assistant", message: { role: "assistant" } }),
      ].join("\n"),
    );

    const original = process.env.HOME;
    process.env.HOME = home;
    try {
      const sessions = listClaudeSessions(cwd);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.id).toBe("sess-uuid");
      expect(sessions[0]!.preview).toContain("login bug");
    } finally {
      process.env.HOME = original;
    }
  });

  it("finds sessions in child project dirs when cwd is a parent", () => {
    const home = mkTmp();
    const parent = "/tmp/my-app";
    const child = "/tmp/my-app/services/api";
    const projectDir = path.join(
      home,
      ".claude",
      "projects",
      encodeClaudeProjectDir(child),
    );
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionFile = path.join(projectDir, "child-sess.jsonl");
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "user",
        cwd: child,
        message: { role: "user", content: "deploy api service" },
      }),
    );

    const original = process.env.HOME;
    process.env.HOME = home;
    try {
      const sessions = listClaudeSessions(parent);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.id).toBe("child-sess");
      expect(sessions[0]!.cwd).toBe(child);
    } finally {
      process.env.HOME = original;
    }
  });
});

describe("listCursorSessions", () => {
  it("reads sessions from agent-transcripts", () => {
    const home = mkTmp();
    const cwd = "/tmp/my-app";
    const projectName = encodeCursorProjectDir(cwd);
    const sessionId = "cursor-sess-uuid";
    const sessionDir = path.join(
      home,
      ".cursor",
      "projects",
      projectName,
      "agent-transcripts",
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, `${sessionId}.jsonl`),
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "<user_query>\nfix cursor resume\n</user_query>" }],
        },
      }),
    );

    const original = process.env.HOME;
    process.env.HOME = home;
    try {
      const sessions = listCursorSessions(cwd);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.id).toBe(sessionId);
      expect(sessions[0]!.preview).toContain("cursor resume");
    } finally {
      process.env.HOME = original;
    }
  });

  it("finds sessions in child project dirs when cwd is a parent", () => {
    const home = mkTmp();
    const parent = "/tmp/my-app";
    const child = "/tmp/my-app/services/api";
    const sessionId = "child-cursor-sess";
    const sessionDir = path.join(
      home,
      ".cursor",
      "projects",
      encodeCursorProjectDir(child),
      "agent-transcripts",
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, `${sessionId}.jsonl`),
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "deploy api service" }],
        },
      }),
    );

    const original = process.env.HOME;
    process.env.HOME = home;
    try {
      const sessions = listCursorSessions(parent);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.id).toBe(sessionId);
    } finally {
      process.env.HOME = original;
    }
  });
});

describe("listCodexSessions", () => {
  it("parses rollout jsonl session_meta", () => {
    const home = mkTmp();
    const cwd = "/tmp/codex-app";
    const sessionDir = path.join(home, ".codex", "sessions", "2026", "03", "31");
    fs.mkdirSync(sessionDir, { recursive: true });
    const id = "019eac4c-a363-7923-8663-2fd8ff72f021";
    const file = path.join(sessionDir, `rollout-${id}.jsonl`);
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id, cwd, type: "message" },
        }),
        JSON.stringify({
          type: "event",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello codex" }],
          },
        }),
      ].join("\n"),
    );

    const original = process.env.HOME;
    process.env.HOME = home;
    try {
      const sessions = listCodexSessions(cwd);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.id).toBe(id);
      expect(sessions[0]!.preview).toBe("hello codex");
    } finally {
      process.env.HOME = original;
    }
  });
});
