import path from "node:path";

export interface CliSessionSummary {
  id: string;
  backend: string;
  cwd: string;
  additionalDirectories?: string[];
  preview: string;
  updatedAt: string;
}

/** Claude Code: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl */
export function encodeClaudeProjectDir(cwd: string): string {
  return path.resolve(cwd).replace(/\//g, "-");
}
