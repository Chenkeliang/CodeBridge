import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveAcpSpawn } from '../packages/backends/dist/index.js';

export function configuredCodexBackends(config) {
  return Object.entries(config.backends).filter(([, profile]) => {
    if (profile.type !== 'codex' || !Object.hasOwn(profile.acpConfig ?? {}, 'network_access')) return false;
    if (typeof profile.acpConfig.network_access !== 'boolean') throw new Error('Codex acpConfig.network_access must be a boolean');
    return true;
  });
}

export function adapterFingerprint(profile) {
  const spawnProfile = resolveAcpSpawn(profile);
  const artifacts = {};
  for (const filename of [spawnProfile.command, ...spawnProfile.args]) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) continue;
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) continue;
    // Hash executable/script arguments only; configuration values and secret refs are never read.
    if (filename !== spawnProfile.command && !/\.(?:mjs|cjs|js)$/.test(filename)) continue;
    artifacts[filename] = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  }
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const executorDigest = createHash('sha256');
  for (const filename of ['acp-session-runner.js', 'acp-config-options.js', 'acp-session-list.js']) {
    executorDigest.update(filename).update(fs.readFileSync(new URL(`../packages/backends/dist/acp/${filename}`, import.meta.url)));
  }
  const executorHash = executorDigest.digest('hex');
  return createHash('sha256').update(JSON.stringify(canonical({ profile, spawnProfile, artifacts, executorHash }))).digest('hex');
}

export async function checkCodexNetwork(config, receipt, listOptions) {
  const results = [];
  for (const [id, profile] of configuredCodexBackends(config)) {
    const options = await listOptions(profile, config.workspaces.root);
    if (!options.some((option) => option.id === 'network_access' && option.type === 'boolean')) {
      throw new Error(`${id}: adapter does not advertise the ACP boolean network_access option; migrate the adapter before upgrading`);
    }
    const accepted = receipt?.schemaVersion === 1 ? receipt.backends?.[id] : undefined;
    if (!accepted || accepted.fingerprint !== adapterFingerprint(profile)) {
      throw new Error(`${id}: missing or stale network acceptance; run pnpm verify:codex-network for this adapter/configuration`);
    }
    for (const phase of ['new', 'pooled-resume', 'cold-resume']) {
      const result = accepted.scenarios?.[phase];
      if (result?.network !== 'PASS' || result?.workspace_write !== 'PASS'
        || result?.outside_write_blocked !== 'PASS' || result?.permissionRequests !== 0) {
        throw new Error(`${id}: incomplete network/filesystem sandbox acceptance for ${phase}`);
      }
    }
    results.push(id);
  }
  return results;
}

export async function loadCandidateConfig(filename) {
  if (!fs.existsSync(filename)) throw new Error(`Config file missing: ${filename}`);
  const { ConfigStore } = await import('../packages/core/dist/index.js');
  return new ConfigStore({ dataDir: path.dirname(filename), configFileName: path.basename(filename), resolve: [] }).get();
}

async function main() {
  const args = process.argv.slice(2);
  const filename = args[args.indexOf('--config') + 1];
  if (!args.includes('--config') || !filename) throw new Error('Usage: node scripts/check-codex-network.mjs --config /absolute/config.yaml');
  const configPath = path.resolve(filename);
  const config = await loadCandidateConfig(configPath);
  const receiptPath = path.join(path.dirname(configPath), 'codex-network-acceptance.json');
  const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : undefined;
  const { listAcpConfigOptions } = await import('../packages/backends/dist/index.js');
  const ids = await checkCodexNetwork(config, receipt, listAcpConfigOptions);
  console.log(ids.length ? `Codex ACP network upgrade checks passed: ${ids.join(', ')}` : 'No explicit Codex ACP network configuration; upgrade check not applicable');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
