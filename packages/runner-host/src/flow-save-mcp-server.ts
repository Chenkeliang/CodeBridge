import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  FLOW_SAVE_AVAILABILITY_ENV,
  FLOW_SAVE_NO_SOURCE_MESSAGE,
  FLOW_SAVE_TOOL_DESCRIPTION,
  FLOW_SAVE_TOOL_NAME,
  RequestFlowSaveInputSchema,
  flowSaveToolOutput,
  parseRequestFlowSaveInput,
  type FlowSaveSourceAvailability,
  type StdioMcpServerConfig,
} from "@codebridge/core";

export function createFlowSaveMcpServer(
  availability: FlowSaveSourceAvailability,
): McpServer {
  const server = new McpServer({
    name: "codebridge-internal",
    version: "1.0.0",
  });
  server.registerTool(FLOW_SAVE_TOOL_NAME, {
    description: FLOW_SAVE_TOOL_DESCRIPTION,
    inputSchema: RequestFlowSaveInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input) => {
    parseRequestFlowSaveInput(input);
    const output = flowSaveToolOutput(availability);
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: { ...output },
    };
  });
  return server;
}

export function createFlowSaveMcpServerConfig(
  scriptPath: string,
  availability: FlowSaveSourceAvailability,
): StdioMcpServerConfig {
  if (!path.isAbsolute(scriptPath)) {
    throw new Error("Flow save MCP server path must be absolute");
  }
  return {
    name: "codebridge-internal",
    command: process.execPath,
    args: [scriptPath],
    env: {
      [FLOW_SAVE_AVAILABILITY_ENV]: availability.available ? "true" : "false",
    },
  };
}

export function readFlowSaveAvailabilityFromEnv(
  env: NodeJS.ProcessEnv,
): FlowSaveSourceAvailability {
  const raw = env[FLOW_SAVE_AVAILABILITY_ENV];
  if (raw === "true") return { available: true };
  if (raw === "false") {
    return {
      available: false,
      code: "no_extractable_previous_run",
      message: FLOW_SAVE_NO_SOURCE_MESSAGE,
    };
  }
  throw new Error(`Missing or invalid ${FLOW_SAVE_AVAILABILITY_ENV}`);
}

async function main(): Promise<void> {
  const server = createFlowSaveMcpServer(
    readFlowSaveAvailabilityFromEnv(process.env),
  );
  await server.connect(new StdioServerTransport());
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
