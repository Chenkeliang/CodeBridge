import { describe, expect, it } from "vitest";
import { runAcpSession } from "./acp/acp-session-runner.js";

// Local JSON-RPC fixture only: no model, network or business tools.
describe("ACP failure details through the subprocess boundary", () => {
  it.each(["initialize", "session/resume", "session/prompt"])("preserves sanitized RPC data when %s fails", async (failureMethod) => {
    const fixture = `
      const rl = require('node:readline').createInterface({ input: process.stdin });
      const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
      rl.on('line', line => {
        const r = JSON.parse(line);
        if (r.id === undefined) return;
        if (r.method === ${JSON.stringify(failureMethod)}) {
          send({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:'Internal error',data:{details:'fetch failed: socket closed',token:'fixture-private-value'}}});
          return;
        }
        const result = r.method === 'initialize'
          ? {protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}}}
          : r.method === 'session/resume' ? {sessionId:'provider-fixture'} : {};
        send({jsonrpc:'2.0',id:r.id,result});
      });
    `;
    const events = [];
    for await (const event of runAcpSession({
      runId: "fixture-run", cwd: "/tmp", prompt: "fixture",
      resumeSessionId: "provider-fixture",
      backendConfig: {type: "codex", acpCommand: process.execPath, acpArgs: ["-e", fixture]},
    }, {permissionPolicy: "prompt_deny", isAborted: () => false}, {})) events.push(event);
    const error = events.find((event) => event.type === "error" && event.fatal);
    expect(error).toMatchObject({type: "error", fatal: true, message: expect.stringContaining("fetch failed: socket closed")});
    expect(JSON.stringify(error)).not.toContain("fixture-private-value");
  }, 10_000);
});
