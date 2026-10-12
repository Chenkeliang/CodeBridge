import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClientConnection, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { RunContext } from "@codebridge/core";
import { applySessionConfigOptions, resolveCustomSessionConfig } from "./acp/acp-config-options.js";
import { listAcpConfigOptions } from "./acp/acp-session-list.js";
import { runAcpSession } from "./acp/acp-session-runner.js";
import { AcpSessionPool } from "./acp/acp-session-pool.js";

type Agent = ClientConnection["agent"];

const network = (value: boolean): SessionConfigOption => ({
  id: "network_access", name: "Allow network access", type: "boolean", currentValue: value,
});

describe("network configuration through a real ACP subprocess", () => {
  it("applies backend defaults and per-session overrides for new, pooled and cold-resumed sessions", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-acp-network-"));
    const logPath = path.join(cwd, "requests.jsonl");
    const fixture = `
      const fs = require('node:fs');
      const rl = require('node:readline').createInterface({ input: process.stdin });
      let value = false;
      const options = () => [{ id: 'network_access', name: 'Network', type: 'boolean', currentValue: value }];
      const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
      rl.on('line', line => {
        const r = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({method:r.method,params:r.params})+'\\n');
        if (r.id === undefined) return;
        let result = {};
        if (r.method === 'initialize') {
          if (!r.params.clientCapabilities.session?.configOptions?.boolean) throw Error('boolean capability missing');
          result = { protocolVersion:1, agentCapabilities:{sessionCapabilities:{resume:{},close:{}}} };
        } else if (r.method === 'session/new' || r.method === 'session/resume') {
          result = {sessionId:r.params.sessionId || 'existing-codex-thread',configOptions:options()};
        } else if (r.method === 'session/set_config_option') {
          if (r.params.configId !== 'network_access' || r.params.type !== 'boolean' || typeof r.params.value !== 'boolean') throw Error('not standard ACP boolean');
          value = r.params.value; result = {configOptions:options()};
        } else if (r.method === 'session/prompt') {
          send({jsonrpc:'2.0',method:'session/update',params:{sessionId:r.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'network='+value}}}});
          result = {stopReason:'end_turn'};
        }
        send({jsonrpc:'2.0',id:r.id,result});
      });
    `;
    const profile = { type: "codex" as const, acpCommand: process.execPath, acpArgs: ["-e", fixture], acpConfig: { network_access: true } };
    let pool = new AcpSessionPool({ enabled: true, idleMs: 60_000, maxPooled: 2 });
    const texts: string[] = [];
    try {
      const listed = await listAcpConfigOptions(profile, cwd);
      expect(listed).toEqual([expect.objectContaining({ id: "network_access", type: "boolean", currentValue: "true" })]);
      let sessionId: string | undefined;
      for (const phase of ["new", "pooled", "cold"] as const) {
        if (phase === "cold") {
          pool.shutdown();
          pool = new AcpSessionPool({ enabled: true, idleMs: 60_000, maxPooled: 2 });
        }
        const ctx: RunContext = {
          runId: phase, cwd, prompt: "inspect", backendConfig: profile,
          ...(sessionId ? { resumeSessionId: sessionId } : {}),
          ...(phase === "pooled" ? { acpConfig: { network_access: false } } : {}),
        };
        const events = [];
        for await (const event of runAcpSession(ctx, { permissionPolicy: "prompt_deny", isAborted: () => false, sessionPool: pool }, {})) events.push(event);
        expect(events.filter((e) => e.type === "error" && e.fatal)).toEqual([]);
        const session = events.find((e) => e.type === "session");
        expect(session).toEqual({ type: "session", sessionId: "existing-codex-thread" });
        if (session?.type === "session") sessionId = session.sessionId;
        texts.push(events.filter((e) => e.type === "text_delta").map((e) => e.type === "text_delta" ? e.text : "").join(""));
      }
      expect(texts).toEqual(["network=true", "network=false", "network=true"]);
      const requests = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(requests.filter((r) => r.method === "session/new")).toHaveLength(2);
      expect(requests.filter((r) => r.method === "session/resume")).toHaveLength(1);
      expect(requests.filter((r) => r.method === "session/set_config_option").map((r) => r.params.value)).toEqual([true, true, false, true]);
    } finally {
      pool.shutdown();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("required ACP network configuration", () => {
  it("uses the same default and override rules for discovery and execution", () => {
    const profile = { type: "codex" as const, acpConfig: { network_access: true } };
    expect(resolveCustomSessionConfig(profile)).toEqual({ custom: { network_access: true }, requiredConfigIds: ["network_access"] });
    expect(resolveCustomSessionConfig(profile, { network_access: false }).custom.network_access).toBe(false);
    expect(() => resolveCustomSessionConfig(profile, { network_access: "true" })).toThrow("boolean");
  });
  it("rejects an adapter without the option instead of prompting with an ineffective setting", async () => {
    const agent = { request: async () => ({ configOptions: [] }) } as unknown as Agent;
    await expect(applySessionConfigOptions(agent, "session", [], {}, { network_access: true }, ["network_access"]))
      .rejects.toThrow("network_access");
  });

  it("rejects a select option in place of the requested boolean", async () => {
    const option = { id: "network_access", name: "Network", type: "select", currentValue: "false", options: [] } as SessionConfigOption;
    const agent = { request: async () => ({ configOptions: [option] }) } as unknown as Agent;
    await expect(applySessionConfigOptions(agent, "session", [option], {}, { network_access: true }, ["network_access"]))
      .rejects.toThrow("network_access");
  });

  it("fails when the RPC rejects even if the old snapshot already equals the requested value", async () => {
    const agent = { request: async () => { throw new Error("unsupported config"); } } as unknown as Agent;
    await expect(applySessionConfigOptions(agent, "session", [network(true)], {}, { network_access: true }, ["network_access"]))
      .rejects.toThrow("unsupported config");
  });

  it("rejects a successful RPC with an unchanged value", async () => {
    const agent = { request: async () => ({ configOptions: [network(false)] }) } as unknown as Agent;
    await expect(applySessionConfigOptions(agent, "session", [network(false)], {}, { network_access: true }, ["network_access"]))
      .rejects.toThrow("network_access");
  });

  it("rejects a response that drops the required configuration", async () => {
    const agent = { request: async () => ({ configOptions: [] }) } as unknown as Agent;
    await expect(applySessionConfigOptions(agent, "session", [network(false)], {}, { network_access: true }, ["network_access"]))
      .rejects.toThrow("network_access");
  });

  it("sends a typed boolean including explicit false", async () => {
    for (const wanted of [true, false]) {
      const calls: unknown[] = [];
      const agent = { request: async (_method: unknown, params: unknown) => {
        calls.push(params); return { configOptions: [network(wanted)] };
      } } as unknown as Agent;
      const result = await applySessionConfigOptions(agent, "session", [network(!wanted)], {}, { network_access: wanted }, ["network_access"]);
      expect(result.warnings).toEqual([]);
      expect(calls).toEqual([{ sessionId: "session", configId: "network_access", type: "boolean", value: wanted }]);
    }
  });

  it("keeps optional custom settings nonfatal", async () => {
    const agent = { request: async () => ({ configOptions: [] }) } as unknown as Agent;
    const result = await applySessionConfigOptions(agent, "session", [], {}, { optional_setting: true });
    expect(result.warnings).toHaveLength(1);
  });
});
