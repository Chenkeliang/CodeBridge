import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CapabilityRegistry,
  CapabilityRuntime,
  McpCapabilityAdapter,
  type CapabilityInvocationContext,
  type CapabilityRisk,
} from "@codebridge/policy";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

export type McpTransport = "stdio" | "http";
export type McpHealthStatus = "unknown" | "healthy" | "unavailable";
export type McpCandidateStatus = "candidate" | "accepted" | "rejected" | "stale";

export interface McpServerDefinition {
  id: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Names of process environment variables to pass to a transport. Values are never persisted. */
  env?: string[];
  revision?: string;
  enabled?: boolean;
}

export interface McpServerRecord extends McpServerDefinition {
  health: {
    status: McpHealthStatus;
    checkedAt: string | null;
    error: string | null;
  };
  updatedAt: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpClient {
  health(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(tool: string, input: Record<string, unknown>, context: CapabilityInvocationContext): Promise<unknown>;
  close?(): Promise<void> | void;
}

export interface McpClientFactory {
  connect(server: McpServerDefinition): Promise<McpClient>;
}

export class SdkMcpClientFactory implements McpClientFactory {
  constructor(
    private readonly clientInfo: { name: string; version: string } = {
      name: "codebridge",
      version: "0.1.0",
    },
  ) {}

  async connect(server: McpServerDefinition): Promise<McpClient> {
    validateServer(server);
    const client = new Client(this.clientInfo, { capabilities: {} });
    const transport = server.transport === "stdio"
      ? new StdioClientTransport({
          command: server.command!,
          args: server.args,
          env: inheritedEnvironment(server.env),
          stderr: "pipe",
        })
      : new StreamableHTTPClientTransport(new URL(server.url!));
    await client.connect(transport);
    return {
      health: async () => { await client.ping(); },
      listTools: async () => {
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        do {
          const result = await client.listTools(cursor ? { cursor } : undefined);
          tools.push(...result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })));
          cursor = result.nextCursor;
        } while (cursor);
        return tools;
      },
      callTool: async (tool, input, context) => client.callTool(
        { name: tool, arguments: input },
        undefined,
        { signal: context.signal },
      ),
      close: async () => { await client.close(); },
    };
  }
}

export interface McpCapabilityCandidate {
  id: string;
  serverId: string;
  toolName: string;
  description: string | null;
  inputSchema: unknown;
  suggestedCapabilityId: string;
  adapterId: string;
  risk: CapabilityRisk;
  revision: string;
  status: McpCandidateStatus;
  observedAt: string;
  reviewedAt: string | null;
}

export interface ApproveMcpCandidateInput {
  capabilityId?: string;
  risk?: CapabilityRisk;
  environments?: string[];
}

export class McpServerRegistry {
  private readonly database: DatabaseSyncType;

  constructor(databasePath = ":memory:") {
    if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        transport TEXT NOT NULL,
        command TEXT,
        args TEXT NOT NULL DEFAULT '[]',
        url TEXT,
        env TEXT NOT NULL DEFAULT '[]',
        revision TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        health_status TEXT NOT NULL DEFAULT 'unknown',
        health_checked_at TEXT,
        health_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_tools (
        server_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        description TEXT,
        input_schema TEXT NOT NULL,
        revision TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (server_id, tool_name)
      );
      CREATE TABLE IF NOT EXISTS mcp_capability_candidates (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        description TEXT,
        input_schema TEXT NOT NULL,
        suggested_capability_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        risk TEXT NOT NULL,
        revision TEXT NOT NULL,
        status TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        reviewed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS mcp_candidates_server_tool
        ON mcp_capability_candidates (server_id, tool_name, status);
    `);
  }

  registerServer(definition: McpServerDefinition): McpServerRecord {
    validateServer(definition);
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO mcp_servers (
        id, transport, command, args, url, env, revision, enabled,
        health_status, health_checked_at, health_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', NULL, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET transport = excluded.transport,
        command = excluded.command, args = excluded.args, url = excluded.url,
        env = excluded.env, revision = excluded.revision, enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      definition.id,
      definition.transport,
      definition.command ?? null,
      JSON.stringify(definition.args ?? []),
      definition.url ?? null,
      JSON.stringify(definition.env ?? []),
      definition.revision ?? null,
      definition.enabled === false ? 0 : 1,
      now,
    );
    return this.getServer(definition.id)!;
  }

  getServer(id: string): McpServerRecord | undefined {
    const row = this.database.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as Row | undefined;
    return row ? toServer(row) : undefined;
  }

  listServers(): McpServerRecord[] {
    return (this.database.prepare("SELECT * FROM mcp_servers ORDER BY id ASC").all() as Row[]).map(toServer);
  }

  recordHealth(id: string, status: McpHealthStatus, error: string | null = null): McpServerRecord {
    if (!this.getServer(id)) throw new Error(`MCP server not found: ${id}`);
    this.database.prepare(
      "UPDATE mcp_servers SET health_status = ?, health_checked_at = ?, health_error = ?, updated_at = ? WHERE id = ?",
    ).run(status, new Date().toISOString(), error, new Date().toISOString(), id);
    return this.getServer(id)!;
  }

  recordTools(serverId: string, tools: McpTool[]): McpCapabilityCandidate[] {
    if (!this.getServer(serverId)) throw new Error(`MCP server not found: ${serverId}`);
    const normalized = tools.map(normalizeTool);
    const currentNames = new Set(normalized.map((tool) => tool.name));
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existingTools = this.database.prepare("SELECT tool_name FROM mcp_tools WHERE server_id = ?").all(serverId) as Row[];
      for (const tool of existingTools) {
        if (!currentNames.has(String(tool.tool_name))) {
          this.database.prepare("UPDATE mcp_capability_candidates SET status = 'stale', reviewed_at = ? WHERE server_id = ? AND tool_name = ? AND status IN ('candidate', 'accepted')").run(now, serverId, String(tool.tool_name));
          this.database.prepare("DELETE FROM mcp_tools WHERE server_id = ? AND tool_name = ?").run(serverId, String(tool.tool_name));
        }
      }
      const server = this.getServer(serverId)!;
      for (const tool of normalized) {
        const revision = toolRevision(server, tool);
        this.database.prepare(`
          INSERT INTO mcp_tools (server_id, tool_name, description, input_schema, revision, observed_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(server_id, tool_name) DO UPDATE SET description = excluded.description,
            input_schema = excluded.input_schema, revision = excluded.revision, observed_at = excluded.observed_at
        `).run(serverId, tool.name, tool.description ?? null, JSON.stringify(tool.inputSchema ?? {}), revision, now);
        const existing = this.database.prepare("SELECT id, status FROM mcp_capability_candidates WHERE server_id = ? AND tool_name = ? AND revision = ?").get(serverId, tool.name, revision) as Row | undefined;
        if (!existing) {
          this.database.prepare(`
            INSERT INTO mcp_capability_candidates (
              id, server_id, tool_name, description, input_schema,
              suggested_capability_id, adapter_id, risk, revision, status, observed_at, reviewed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'read_only', ?, 'candidate', ?, NULL)
          `).run(
            `mcp_candidate_${shortHash(`${serverId}:${tool.name}:${revision}`)}`,
            serverId,
            tool.name,
            tool.description ?? null,
            JSON.stringify(tool.inputSchema ?? {}),
            suggestedCapabilityId(serverId, tool.name),
            adapterId(serverId, tool.name),
            revision,
            now,
          );
        } else if (existing.status === "stale") {
          this.database.prepare("UPDATE mcp_capability_candidates SET status = 'candidate', reviewed_at = NULL, observed_at = ? WHERE id = ?").run(now, String(existing.id));
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.listCandidates(serverId).filter((candidate) => currentNames.has(candidate.toolName));
  }

  getCandidate(id: string): McpCapabilityCandidate | undefined {
    const row = this.database.prepare("SELECT * FROM mcp_capability_candidates WHERE id = ?").get(id) as Row | undefined;
    return row ? toCandidate(row) : undefined;
  }

  listCandidates(serverId?: string): McpCapabilityCandidate[] {
    const rows = serverId
      ? this.database.prepare("SELECT * FROM mcp_capability_candidates WHERE server_id = ? ORDER BY tool_name ASC, observed_at DESC").all(serverId)
      : this.database.prepare("SELECT * FROM mcp_capability_candidates ORDER BY observed_at DESC, id ASC").all();
    return (rows as Row[]).map(toCandidate);
  }

  approveCandidate(id: string, input: ApproveMcpCandidateInput = {}): McpCapabilityCandidate {
    const candidate = this.getCandidate(id);
    if (!candidate) throw new Error(`MCP capability candidate not found: ${id}`);
    if (candidate.status !== "candidate") throw new Error(`MCP capability candidate is not reviewable: ${id}`);
    this.database.prepare(
      "UPDATE mcp_capability_candidates SET suggested_capability_id = ?, risk = ?, status = 'accepted', reviewed_at = ? WHERE id = ?",
    ).run(input.capabilityId ?? candidate.suggestedCapabilityId, input.risk ?? candidate.risk, new Date().toISOString(), id);
    return this.getCandidate(id)!;
  }

  rejectCandidate(id: string): McpCapabilityCandidate {
    const candidate = this.getCandidate(id);
    if (!candidate) throw new Error(`MCP capability candidate not found: ${id}`);
    this.database.prepare("UPDATE mcp_capability_candidates SET status = 'rejected', reviewed_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return this.getCandidate(id)!;
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

export class McpRuntime {
  private readonly clients = new Map<string, McpClient>();

  constructor(
    private readonly registry: McpServerRegistry,
    private readonly factory: McpClientFactory,
    private readonly capabilities: CapabilityRegistry,
    private readonly adapters: CapabilityRuntime,
  ) {}

  async discover(serverId: string): Promise<McpCapabilityCandidate[]> {
    const client = await this.client(serverId);
    try {
      const tools = await client.listTools();
      this.registry.recordHealth(serverId, "healthy");
      return this.registry.recordTools(serverId, tools);
    } catch (error) {
      this.registry.recordHealth(serverId, "unavailable", messageOf(error));
      throw error;
    }
  }

  async refreshHealth(serverId: string): Promise<McpServerRecord> {
    const client = await this.client(serverId);
    try {
      await client.health();
      return this.registry.recordHealth(serverId, "healthy");
    } catch (error) {
      this.registry.recordHealth(serverId, "unavailable", messageOf(error));
      throw error;
    }
  }

  async approveCandidate(id: string, input: ApproveMcpCandidateInput = {}): Promise<McpCapabilityCandidate> {
    const current = this.registry.getCandidate(id);
    if (!current) throw new Error(`MCP capability candidate not found: ${id}`);
    const server = this.registry.getServer(current.serverId);
    if (!server) throw new Error(`MCP server not found: ${current.serverId}`);
    const accepted = this.registry.approveCandidate(id, input);
    const capabilityId = accepted.suggestedCapabilityId;
    const adapter = accepted.adapterId;
    this.capabilities.register({
      id: capabilityId,
      risk: accepted.risk,
      adapter,
      environments: input.environments,
      description: accepted.description ?? undefined,
      source: {
        kind: "mcp",
        ref: `${accepted.serverId}/${accepted.toolName}`,
        version: server.revision,
        revision: accepted.revision,
      },
    });
    this.adapters.register(new McpCapabilityAdapter(adapter, accepted.toolName, async (tool, toolInput, context) => {
      const client = await this.client(accepted.serverId);
      return client.callTool(tool, toolInput, context);
    }));
    return accepted;
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.close?.()));
  }

  private async client(serverId: string): Promise<McpClient> {
    const current = this.clients.get(serverId);
    if (current) return current;
    const server = this.registry.getServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    if (server.enabled === false) throw new Error(`MCP server is disabled: ${serverId}`);
    const client = await this.factory.connect(server);
    this.clients.set(serverId, client);
    return client;
  }
}

type Row = Record<string, unknown>;

function validateServer(server: McpServerDefinition): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(server.id)) throw new Error("MCP server id must be lowercase and stable");
  if (server.transport === "stdio" && !server.command?.trim()) throw new Error("stdio MCP server requires command");
  if (server.transport === "http" && !server.url?.trim()) throw new Error("http MCP server requires url");
}

function inheritedEnvironment(names: string[] | undefined): Record<string, string> | undefined {
  if (!names?.length) return undefined;
  const environment = getDefaultEnvironment();
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function normalizeTool(tool: McpTool): McpTool {
  if (!tool.name.trim()) throw new Error("MCP tool name must not be empty");
  return {
    name: tool.name.trim(),
    description: tool.description?.trim() || undefined,
    inputSchema: tool.inputSchema ?? {},
  };
}

function toolRevision(server: McpServerRecord, tool: McpTool): string {
  return `sha256:${createHash("sha256").update(stableStringify({ server: server.revision ?? null, tool })).digest("hex")}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function suggestedCapabilityId(serverId: string, toolName: string): string {
  return `mcp.${safePart(serverId)}.${safePart(toolName)}`;
}

function adapterId(serverId: string, toolName: string): string {
  return `mcp:${serverId}/${toolName}`;
}

function safePart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tool";
}

function toServer(row: Row): McpServerRecord {
  return {
    id: String(row.id),
    transport: String(row.transport) as McpTransport,
    command: row.command === null ? undefined : String(row.command),
    args: JSON.parse(String(row.args ?? "[]")) as string[],
    url: row.url === null ? undefined : String(row.url),
    env: JSON.parse(String(row.env ?? "[]")) as string[],
    revision: row.revision === null ? undefined : String(row.revision),
    enabled: Number(row.enabled) === 1,
    health: {
      status: String(row.health_status) as McpHealthStatus,
      checkedAt: row.health_checked_at === null ? null : String(row.health_checked_at),
      error: row.health_error === null ? null : String(row.health_error),
    },
    updatedAt: String(row.updated_at),
  };
}

function toCandidate(row: Row): McpCapabilityCandidate {
  return {
    id: String(row.id),
    serverId: String(row.server_id),
    toolName: String(row.tool_name),
    description: row.description === null ? null : String(row.description),
    inputSchema: JSON.parse(String(row.input_schema ?? "{}")) as unknown,
    suggestedCapabilityId: String(row.suggested_capability_id),
    adapterId: String(row.adapter_id),
    risk: String(row.risk) as CapabilityRisk,
    revision: String(row.revision),
    status: String(row.status) as McpCandidateStatus,
    observedAt: String(row.observed_at),
    reviewedAt: row.reviewed_at === null ? null : String(row.reviewed_at),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
