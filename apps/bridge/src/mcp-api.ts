import { Hono } from "hono";
import type {
  ApproveMcpCandidateInput,
  McpRuntime,
  McpServerRegistry,
} from "@codebridge/mcp-runtime";
import type { CapabilityRisk } from "@codebridge/policy";

const RISKS = new Set<CapabilityRisk>([
  "read_only",
  "workspace_write",
  "git_write",
  "production_write",
]);

export function createMcpApp(
  registry: McpServerRegistry,
  runtime: McpRuntime,
  token: string,
) {
  const app = new Hono();
  app.use("/v1/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) {
      return c.json({ error: { code: "unauthorized", message: "未授权" } }, 401);
    }
    await next();
  });

  app.get("/v1/mcp/servers", (c) => c.json({ servers: registry.listServers().map(toApiServer) }));
  app.get("/v1/mcp/candidates", (c) => c.json({ candidates: registry.listCandidates().map(toApiCandidate) }));

  app.post("/v1/mcp/servers/:server_id/discover", async (c) => {
    try {
      const candidates = await runtime.discover(c.req.param("server_id"));
      return c.json({ candidates: candidates.map(toApiCandidate) });
    } catch (error) {
      const message = messageOf(error);
      const status = message.includes("not found") ? 404 : 503;
      return c.json({ error: { code: status === 404 ? "mcp_server_not_found" : "mcp_discovery_failed", message } }, status);
    }
  });

  app.post("/v1/mcp/candidates/:candidate_id/approve", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const risk = body?.risk;
    if (risk !== undefined && (typeof risk !== "string" || !RISKS.has(risk as CapabilityRisk))) {
      return c.json({ error: { code: "invalid_capability_risk", message: "risk 无效" } }, 400);
    }
    const environments = body?.environments;
    if (environments !== undefined && (!Array.isArray(environments) || environments.some((value) => typeof value !== "string" || !value.trim()))) {
      return c.json({ error: { code: "invalid_environments", message: "environments 必须是非空字符串数组" } }, 400);
    }
    const input: ApproveMcpCandidateInput = {
      capabilityId: typeof body?.capability_id === "string" && body.capability_id.trim() ? body.capability_id : undefined,
      risk: risk as CapabilityRisk | undefined,
      environments: environments as string[] | undefined,
    };
    try {
      return c.json(toApiCandidate(await runtime.approveCandidate(c.req.param("candidate_id"), input)));
    } catch (error) {
      const message = messageOf(error);
      const status = message.includes("not found") ? 404 : 409;
      return c.json({ error: { code: status === 404 ? "mcp_candidate_not_found" : "mcp_candidate_not_reviewable", message } }, status);
    }
  });

  app.post("/v1/mcp/candidates/:candidate_id/reject", (c) => {
    try {
      return c.json(toApiCandidate(registry.rejectCandidate(c.req.param("candidate_id"))));
    } catch (error) {
      return c.json({ error: { code: "mcp_candidate_not_found", message: messageOf(error) } }, 404);
    }
  });

  return app;
}

function toApiServer(server: ReturnType<McpServerRegistry["listServers"]>[number]) {
  return {
    id: server.id,
    transport: server.transport,
    command: server.command,
    args: server.args ?? [],
    url: server.url,
    env: server.env ?? [],
    revision: server.revision,
    enabled: server.enabled,
    health: {
      status: server.health.status,
      checked_at: server.health.checkedAt,
      error: server.health.error,
    },
    updated_at: server.updatedAt,
  };
}

function toApiCandidate(candidate: ReturnType<McpServerRegistry["listCandidates"]>[number]) {
  return {
    id: candidate.id,
    server_id: candidate.serverId,
    tool_name: candidate.toolName,
    description: candidate.description,
    input_schema: candidate.inputSchema,
    suggested_capability_id: candidate.suggestedCapabilityId,
    adapter_id: candidate.adapterId,
    risk: candidate.risk,
    revision: candidate.revision,
    status: candidate.status,
    observed_at: candidate.observedAt,
    reviewed_at: candidate.reviewedAt,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
