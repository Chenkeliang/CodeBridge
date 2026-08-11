import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ArtifactKind, VerificationStatus } from "@codebridge/work-items";

export type CapabilityAdapterKind = "function" | "skill" | "mcp" | "cli" | "http";

export interface CapabilityInvocationContext {
  cwd?: string;
  environment?: string;
  runId?: string;
  stepId?: string;
  signal?: AbortSignal;
}

export interface CapabilityInvocation {
  input: Record<string, unknown>;
  context: CapabilityInvocationContext;
}

export interface CapabilityArtifact {
  name: string;
  content: string;
  mimeType?: string;
  kind?: ArtifactKind;
  metadata?: Record<string, unknown>;
}

export interface CapabilityExecutionResult {
  output?: unknown;
  artifacts?: CapabilityArtifact[];
  /** Skill instructions are context for the Agent; other adapters complete the step. */
  forwardToAgent?: boolean;
  retryable?: boolean;
  metadata?: Record<string, unknown>;
  verification?: {
    validator: string;
    status: VerificationStatus;
    summary: string;
  };
}

export class CapabilityExecutionError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = "CapabilityExecutionError";
    this.retryable = options.retryable ?? false;
  }
}

export interface CapabilityAdapter {
  readonly id: string;
  readonly kind: CapabilityAdapterKind;
  execute(invocation: CapabilityInvocation): Promise<CapabilityExecutionResult>;
}

export class CapabilityRuntime {
  private readonly adapters = new Map<string, CapabilityAdapter>();

  constructor(adapters: CapabilityAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: CapabilityAdapter): void {
    if (!adapter.id.trim()) throw new Error("capability adapter id must not be empty");
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): CapabilityAdapter | undefined {
    return this.adapters.get(id);
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  list(): CapabilityAdapter[] {
    return [...this.adapters.values()];
  }

  async execute(id: string, invocation: CapabilityInvocation): Promise<CapabilityExecutionResult> {
    const adapter = this.get(id);
    if (!adapter) throw new Error(`Capability adapter not registered: ${id}`);
    return adapter.execute(invocation);
  }
}

export class FunctionCapabilityAdapter implements CapabilityAdapter {
  readonly kind = "function" as const;

  constructor(
    readonly id: string,
    private readonly handler: (
      invocation: CapabilityInvocation,
    ) => Promise<CapabilityExecutionResult> | CapabilityExecutionResult,
  ) {}

  async execute(invocation: CapabilityInvocation): Promise<CapabilityExecutionResult> {
    return this.handler(invocation);
  }
}

export interface McpCall {
  (tool: string, input: Record<string, unknown>, context: CapabilityInvocationContext):
    Promise<unknown>;
}

export class McpCapabilityAdapter implements CapabilityAdapter {
  readonly kind = "mcp" as const;

  constructor(
    readonly id: string,
    private readonly tool: string,
    private readonly call: McpCall,
  ) {}

  async execute(invocation: CapabilityInvocation): Promise<CapabilityExecutionResult> {
    return { output: await this.call(this.tool, invocation.input, invocation.context) };
  }
}

export interface CliCapabilityOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export class CliCapabilityAdapter implements CapabilityAdapter {
  readonly kind = "cli" as const;

  constructor(readonly id: string, private readonly options: CliCapabilityOptions) {}

  async execute(invocation: CapabilityInvocation): Promise<CapabilityExecutionResult> {
    const { command, args = [], env, timeoutMs = 120_000 } = this.options;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: invocation.context.cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        signal: invocation.context.signal,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Capability CLI failed (${code ?? signal ?? "unknown"}): ${stderr.trim()}`));
          return;
        }
        resolve({ output: parseOutput(stdout), metadata: { stderr: stderr.trim() || undefined } });
      });
      child.stdin.end(JSON.stringify(invocation.input));
    });
  }
}

export interface HttpCapabilityOptions {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class HttpCapabilityAdapter implements CapabilityAdapter {
  readonly kind = "http" as const;

  constructor(readonly id: string, private readonly options: HttpCapabilityOptions) {}

  async execute(invocation: CapabilityInvocation): Promise<CapabilityExecutionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    const signal = invocation.context.signal
      ? AbortSignal.any([invocation.context.signal, controller.signal])
      : controller.signal;
    try {
      const response = await fetch(this.options.url, {
        method: this.options.method ?? "POST",
        headers: { "content-type": "application/json", ...this.options.headers },
        body: this.options.method === "GET" ? undefined : JSON.stringify(invocation.input),
        signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Capability HTTP failed (${response.status}): ${text.slice(0, 500)}`);
      return { output: parseOutput(text), metadata: { status: response.status } };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface SkillDocument {
  id: string;
  directory: string;
  file: string;
  content: string;
}

/** Discover standard SKILL.md files without imposing a script language or metadata format. */
export function discoverSkillDocuments(roots: string[]): SkillDocument[] {
  const documents: SkillDocument[] = [];
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    walkSkillRoot(resolvedRoot, resolvedRoot, documents);
  }
  return documents.sort((a, b) => a.id.localeCompare(b.id));
}

export class SkillCapabilityAdapter implements CapabilityAdapter {
  readonly kind = "skill" as const;

  constructor(readonly id: string, private readonly document: SkillDocument) {}

  async execute(): Promise<CapabilityExecutionResult> {
    return {
      output: { skillId: this.document.id, instructions: this.document.content },
      forwardToAgent: true,
      metadata: { file: this.document.file },
    };
  }
}

function walkSkillRoot(root: string, directory: string, documents: SkillDocument[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkSkillRoot(root, fullPath, documents);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      documents.push({
        id: path.relative(root, directory).replaceAll(path.sep, "/") || path.basename(root),
        directory,
        file: fullPath,
        content: fs.readFileSync(fullPath, "utf8"),
      });
    }
  }
}

function parseOutput(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}
