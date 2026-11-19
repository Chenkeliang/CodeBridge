import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../packages/core/dist/index.js";
import { probeCodexCompactionSupport } from "../packages/backends/dist/index.js";
import { COMMAND_PROTOCOL, codexCompactionFingerprint } from "../packages/runner-host/dist/compaction-evidence.js";
import { RunnerHost } from "../packages/runner-host/dist/server.js";
import { AgentSession } from "../packages/backends/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const configPath = process.argv[2];
if (typeof AgentSession.prototype.compact !== "function" || typeof AgentSession.prototype.abortCompaction !== "function"
  || typeof RunnerHost.prototype.compactSession !== "function" || typeof RunnerHost.prototype.readCompactionResult !== "function") {
  throw new Error("Agent command contract unavailable");
}
if (configPath === "--artifact") {
  process.stdout.write(JSON.stringify({ protocol: COMMAND_PROTOCOL, piSdk: true }) + "\n");
  process.exit(0);
}
if (!configPath || !fs.statSync(configPath).isFile()) throw new Error("Runner configuration required");
const config = new ConfigStore({ dataDir: path.dirname(configPath), configFileName: path.basename(configPath), resolve: [] }).get();
const checks = new Map();
const codexProfiles = {};
for (const [id, profile] of Object.entries(config.backends)) {
  if (profile.type !== "codex") continue;
  let fingerprint;
  try {
    fingerprint = codexCompactionFingerprint(profile);
  } catch {
    continue;
  }
  if (!checks.has(fingerprint)) checks.set(fingerprint, await probeCodexCompactionSupport(profile, os.tmpdir()).catch(() => false));
  if (checks.get(fingerprint)) codexProfiles[id] = fingerprint;
}
process.stdout.write(JSON.stringify({ protocol: COMMAND_PROTOCOL, piSdk: true, codexProfiles }));
