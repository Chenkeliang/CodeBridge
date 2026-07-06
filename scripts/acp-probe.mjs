#!/usr/bin/env node
/**
 * ACP capability probe — JSON-RPC smoke tests for Cursor / Claude / Codex agents.
 * Usage:
 *   node scripts/acp-probe.mjs
 *   node scripts/acp-probe.mjs --backend cursor|claude|codex
 */
import { spawn } from "node:child_process";
import readline from "node:readline";
import { homedir } from "node:os";
import { resolve } from "node:path";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const AGENTS = {
  cursor: { command: "cursor-agent", args: ["acp"] },
  claude: {
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.55.0"],
  },
  codex: {
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.1.0"],
  },
};

function parseArgs(argv) {
  let backend;
  let cwd = resolve(homedir(), "Projects/feishu-code-bridge");
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--backend" && argv[i + 1]) backend = argv[++i];
    else if (argv[i] === "--cwd" && argv[i + 1]) cwd = resolve(argv[++i]);
  }
  return { backend, cwd };
}

const rpc = (id, method, params) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

function runDialog(command, args, handlers, ms = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const rl = readline.createInterface({ input: child.stdout });
    let stderr = "";
    const pending = new Map();
    let nextId = 0;

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const send = (method, params) =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        child.stdin.write(rpc(id, method, params));
      });

    rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.method === "session/request_permission") {
        const opts = msg.params?.options ?? [];
        const allow = opts[0];
        if (allow) {
          child.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                outcome: {
                  outcome: "selected",
                  optionId: allow.optionId ?? allow.id,
                },
              },
            }) + "\n",
          );
        }
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });

    const finish = (result) => {
      child.kill("SIGTERM");
      resolve({ ...result, stderr });
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: "timeout" }),
      ms,
    );

    handlers(send)
      .then((result) => {
        clearTimeout(timer);
        finish(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        finish({ ok: false, error: err.message });
      });
  });
}

async function probeAgent(agentKey, cwd) {
  const { command, args } = AGENTS[agentKey];
  const results = { agent: agentKey };

  results.initialize = await runDialog(command, args, async (send) => {
    const msg = await send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "fcb-probe", version: "0.1.0" },
    });
    return { ok: !msg.error, error: msg.error };
  });

  results.promptText = await runDialog(command, args, async (send) => {
    await send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "fcb-probe", version: "0.1.0" },
    });
    const s = await send("session/new", { cwd, mcpServers: [] });
    const p = await send("session/prompt", {
      sessionId: s.result.sessionId,
      prompt: [{ type: "text", text: "Reply exactly: PONG" }],
    });
    return { ok: !p.error, stopReason: p.result?.stopReason };
  });

  results.promptImage = await runDialog(command, args, async (send) => {
    await send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "fcb-probe", version: "0.1.0" },
    });
    const s = await send("session/new", { cwd, mcpServers: [] });
    const p = await send("session/prompt", {
      sessionId: s.result.sessionId,
      prompt: [
        { type: "image", mimeType: "image/png", data: PNG_B64 },
        { type: "text", text: "One word: color?" },
      ],
    });
    return { ok: !p.error, stopReason: p.result?.stopReason };
  });

  results.ok = Object.entries(results)
    .filter(([k]) => k !== "agent" && k !== "ok")
    .every(([, v]) => v?.ok !== false);

  return results;
}

const { backend, cwd } = parseArgs(process.argv);
const keys = backend ? [backend] : Object.keys(AGENTS);

console.log(`ACP probe cwd=${cwd}\n`);
const all = [];
for (const key of keys) {
  if (!AGENTS[key]) {
    console.error(`Unknown backend: ${key}`);
    process.exit(2);
  }
  console.log(`--- ${key} ---`);
  const r = await probeAgent(key, cwd);
  all.push(r);
  for (const [name, val] of Object.entries(r)) {
    if (name === "agent" || name === "ok") continue;
    console.log(`  ${name}:`, val?.ok === false ? "FAIL" : "pass");
  }
  console.log(`  overall: ${r.ok ? "PASS" : "FAIL"}\n`);
}

process.exit(all.some((r) => !r.ok) ? 1 : 0);
