#!/usr/bin/env node
/**
 * Live ACP smoke test via Runner HTTP API (requires running Runner).
 *
 *   RUNNER_URL=http://127.0.0.1:19789 RUNNER_TOKEN=... node scripts/test-acp-live.mjs
 *   node scripts/test-acp-live.mjs --backend cursor
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:19789";
const RUNNER_TOKEN = process.env.RUNNER_TOKEN ?? "";
const cwd =
  process.env.FCB_CWD ?? resolve(homedir(), "Projects/feishu-code-bridge");

function parseArgs(argv) {
  let backend = "cursor";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--backend" && argv[i + 1]) backend = argv[++i];
  }
  return { backend };
}

async function parseSse(response) {
  const text = await response.text();
  const events = [];
  for (const block of text.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data: ")) continue;
    try {
      events.push(JSON.parse(line.slice(6)));
    } catch {
      /* ignore */
    }
  }
  return events;
}

async function runOnce(backend) {
  const runId = `acp-live-${Date.now()}`;
  const res = await fetch(`${RUNNER_URL}/runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${RUNNER_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      runId,
      sessionKey: { chatId: "live-test", backendId: backend, cwd },
      prompt: "Reply with exactly: PONG",
    }),
  });
  if (!res.ok) {
    throw new Error(`POST /runs ${res.status}: ${await res.text()}`);
  }
  const events = await parseSse(res);
  const text = events
    .filter((e) => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
  const session = events.find((e) => e.type === "session");
  const done = events.find((e) => e.type === "done");
  const errors = events.filter((e) => e.type === "error");
  return { text, session, done, errors, eventCount: events.length };
}

async function listSessions(backend) {
  const url = new URL(`${RUNNER_URL}/sessions`);
  url.searchParams.set("backend", backend);
  url.searchParams.set("cwd", cwd);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${RUNNER_TOKEN}` },
  });
  if (!res.ok) throw new Error(`GET /sessions ${res.status}`);
  return res.json();
}

async function main() {
  if (!RUNNER_TOKEN) {
    console.error("Set RUNNER_TOKEN (from config.yaml runner.token)");
    process.exit(2);
  }
  const { backend } = parseArgs(process.argv);
  console.log(`ACP live test backend=${backend} cwd=${cwd}`);

  const health = await fetch(`${RUNNER_URL}/health`, {
    headers: { authorization: `Bearer ${RUNNER_TOKEN}` },
  });
  console.log("health:", health.status, await health.json());

  const run = await runOnce(backend);
  console.log("run:", {
    sessionId: run.session?.sessionId,
    textPreview: run.text.slice(0, 120),
    exitCode: run.done?.exitCode,
    errors: run.errors,
    eventCount: run.eventCount,
  });

  const sessions = await listSessions(backend);
  console.log("sessions:", sessions.sessions?.length ?? 0);

  const ok =
    run.done?.exitCode === 0 &&
    run.errors.filter((e) => e.fatal).length === 0 &&
    (run.text.length > 0 || run.eventCount > 2);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
