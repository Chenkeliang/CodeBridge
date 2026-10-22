import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// Each subprocess records only protocol calls; it never performs a business write.
describe("Codex workspace discovery recovery", () => {
  it.each([
    { detail: "workspace routing discovery failed", failures: 2, starts: 3, prompts: 1, fatal: 0 },
    { detail: "workspace routing discovery timed out", failures: 1, starts: 2, prompts: 1, fatal: 0 },
    { detail: "workspace routing discovery failed", failures: 99, starts: 3, prompts: 0, fatal: 1 },
    { detail: "workspace routing discovery unauthorized (401)", failures: 99, starts: 1, prompts: 0, fatal: 1 },
    { detail: "selected workspace missing from routing discovery", failures: 99, starts: 1, prompts: 0, fatal: 1 },
    { detail: "unclassified internal error", failures: 99, starts: 1, prompts: 0, fatal: 1 },
    { detail: "workspace routing discovery failed", failures: 99, starts: 1, prompts: 1, fatal: 1, duringPrompt: true },
    { detail: "workspace routing discovery failed", failures: 99, starts: 1, prompts: 0, fatal: 0, cancelOnRetry: true },
  ])("bounds initialization only: $detail, failures=$failures, duringPrompt=$duringPrompt, cancel=$cancelOnRetry", async (test) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-routing-"));
    const log = path.join(cwd, "calls.jsonl");
    const fixture = `
      const fs = require('node:fs');
      const log = ${JSON.stringify(log)};
      const calls = () => fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
      const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
      const rl = require('node:readline').createInterface({input:process.stdin});
      rl.on('line', line => {
        const r = JSON.parse(line); if (r.id === undefined) return;
        fs.appendFileSync(log,JSON.stringify({method:r.method,sessionId:r.params?.sessionId})+'\\n');
        if (r.method === 'session/resume' && !${Boolean(test.duringPrompt)} && calls().filter(x=>x.method==='session/resume').length <= ${test.failures}) {
          send({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:'Internal error',data:{details:${JSON.stringify(test.detail)}}}}); return;
        }
        if (r.method === 'session/prompt') {
          if (${Boolean(test.duringPrompt)}) {
            send({jsonrpc:'2.0',method:'session/update',params:{sessionId:r.params.sessionId,update:{sessionUpdate:'tool_call',toolCallId:'business-fixture',title:'write_fixture',kind:'edit',status:'in_progress'}}});
            send({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:'Internal error',data:{details:${JSON.stringify(test.detail)}}}}); return;
          }
          send({jsonrpc:'2.0',method:'session/update',params:{sessionId:r.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ok'}}}});
          send({jsonrpc:'2.0',id:r.id,result:{stopReason:'end_turn'}}); return;
        }
        send({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}}}:{sessionId:'original-provider'}});
      });
    `;
    let aborted = false;
    const events = [];
    try {
      for await (const event of runAcpSession({
        runId: "routing-fixture", cwd, prompt: "one original user message", resumeSessionId: "original-provider",
        backendConfig: { type: "codex", acpCommand: process.execPath, acpArgs: ["-e", fixture] },
      }, {permissionPolicy: "prompt_deny", isAborted: () => aborted, drainBackgroundWork: false}, {})) {
        events.push(event);
        if (test.cancelOnRetry && event.type === "text_delta" && event.phase === "commentary") aborted = true;
      }
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.filter((c) => c.method === "initialize")).toHaveLength(test.starts);
      expect(calls.filter((c) => c.method === "session/prompt")).toHaveLength(test.prompts);
      expect(calls.filter((c) => c.method === "session/new")).toHaveLength(0);
      expect(calls.filter((c) => c.method === "session/resume").every((c) => c.sessionId === "original-provider")).toBe(true);
      expect(events.filter((e) => e.type === "error" && e.fatal)).toHaveLength(test.fatal);
      if (test.fatal) expect(events.find((e) => e.type === "error" && e.fatal)).toMatchObject({message: expect.stringContaining(test.detail)});
      if (test.duringPrompt) expect(events.filter((e) => e.type === "tool_start")).toHaveLength(1);
      if (test.cancelOnRetry) expect(aborted).toBe(true);
    } finally {
      fs.rmSync(cwd, {recursive: true, force: true});
    }
  }, 10_000);
});
