import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { repositoryRoot, checkVersions } from './package-release.mjs';

const { manifest } = checkVersions(repositoryRoot);
const artifact = path.join(repositoryRoot, 'dist', `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`);
assert.ok(fs.existsSync(artifact), 'Run pnpm package:release first');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codebridge-install-'));
const children = [];
const env = { PATH: process.env.PATH, HOME: path.join(scratch, 'home'), DATA_DIR: path.join(scratch, 'data') };
fs.mkdirSync(env.HOME, { recursive: true });
fs.writeFileSync(path.join(scratch, 'package.json'), '{"private":true}\n');

function run(file, args) {
  return execFileSync(file, args, { cwd: scratch, env, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function start(file, args) {
  const child = spawn(file, args, { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { child, output: '' };
  children.push(entry);
  child.stdout.on('data', (chunk) => { entry.output += chunk; });
  child.stderr.on('data', (chunk) => { entry.output += chunk; });
  return entry;
}
async function waitFor(url, entry, headers = {}) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (entry.child.exitCode !== null) throw new Error(`Packaged process exited: ${entry.output}`);
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
    } catch { /* Wait for this isolated test process to bind its port. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Package did not become ready: ${entry.output}`);
}

try {
  console.log('Installing tarball into a clean temporary project (no audit, no real service credentials)...');
  run('npm', ['install', '--no-audit', '--no-fund', artifact]);
  // The installed services must not discover or probe the developer's real Agent CLIs.
  const runtimeBin = path.join(scratch, 'bin');
  fs.mkdirSync(runtimeBin);
  fs.symlinkSync(process.execPath, path.join(runtimeBin, 'node'));
  env.PATH = `${runtimeBin}:/usr/bin:/bin`;
  const installed = path.join(scratch, 'node_modules', manifest.name);
  const modules = path.join(installed, 'node_modules/@codebridge');
  const bin = path.join(scratch, 'node_modules/.bin');
  const bridge = path.join(bin, 'codebridge');
  const runner = path.join(bin, 'codebridge-runner');
  assert.equal(run(bridge, ['--version']).trim(), manifest.version);
  assert.equal(run(runner, ['--version']).trim(), manifest.version);
  const coreMetadataPath = path.join(modules, 'core/package.json');
  const originalMetadata = fs.readFileSync(coreMetadataPath, 'utf8');
  const probeMetadata = JSON.parse(originalMetadata);
  probeMetadata.version = '0.0.0-smoke';
  fs.writeFileSync(coreMetadataPath, JSON.stringify(probeMetadata));
  assert.equal(run(bridge, ['--version']).trim(), '0.0.0-smoke');
  assert.equal(run(runner, ['--version']).trim(), '0.0.0-smoke');
  fs.writeFileSync(coreMetadataPath, originalMetadata);
  assert.match(run(bridge, ['--help']), /init/);
  assert.match(run(runner, ['--help']), /codebridge-runner/);
  assert.ok(!fs.existsSync(env.DATA_DIR), 'help/version must not initialize configuration');
  run(bridge, ['init', '--defaults', '--data-dir', env.DATA_DIR]);
  const configFile = path.join(env.DATA_DIR, 'config.yaml');
  const initial = fs.readFileSync(configFile, 'utf8');
  assert.ok(!initial.includes('change-me-runner-token'));
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  run(bridge, ['init', '--defaults', '--data-dir', env.DATA_DIR]);
  assert.equal(fs.readFileSync(configFile, 'utf8'), initial);

  // Resolve imports from the installed tree only, not from this checkout's node_modules.
  const probe = path.join(installed, 'probe.mjs');
  fs.writeFileSync(probe, `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
const root = path.dirname(fileURLToPath(import.meta.url));
for (const folder of fs.readdirSync(path.join(root, 'node_modules/@codebridge'))) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@codebridge', folder, 'package.json')));
  if (pkg.exports?.['.']) await import(pkg.name);
}
const config = parse(fs.readFileSync(process.env.DATA_DIR + '/config.yaml', 'utf8'));
config.web.enabled = true;
config.runner.url = 'http://127.0.0.1:' + process.argv[2];
config.runnerHost = { listen: '127.0.0.1:' + process.argv[2] };
config.bridge = { apiPort: Number(process.argv[3]) };
fs.writeFileSync(process.env.DATA_DIR + '/config.yaml', stringify(config));
console.log(config.runner.token);
`);
  const runnerPort = await freePort();
  const bridgePort = await freePort();
  const token = run(process.execPath, [probe, String(runnerPort), String(bridgePort)]).trim();
  const runnerProcess = start(runner, []);
  const health = await waitFor(`http://127.0.0.1:${runnerPort}/health`, runnerProcess, { authorization: `Bearer ${token}` });
  assert.equal((await health.json()).version, manifest.version);
  assert.equal((await fetch(`http://127.0.0.1:${runnerPort}/health`)).status, 401);
  assert.ok(fs.existsSync(path.join(modules, 'runner-host/dist/deployment-mcp-server.js')));
  const bridgeProcess = start(bridge, ['start', '--data-dir', env.DATA_DIR]);
  const page = await waitFor(`http://127.0.0.1:${bridgePort}/workbench/`, bridgeProcess);
  const html = await page.text();
  assert.match(html, /<html/);
  const asset = html.match(/src="([^\"]+\.js)"/)?.[1];
  assert.ok(asset, 'Workbench JavaScript must be referenced');
  assert.equal((await fetch(new URL(asset, `http://127.0.0.1:${bridgePort}`))).status, 200);
  // The actual packaged backend entry modules were imported by probe; no agent tasks are sent.
  console.log(`PASS: ${manifest.name}@${manifest.version}, CLI/init, internal imports, authenticated Runner and Workbench assets`);
} finally {
  await Promise.all(children.map(async ({ child }) => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }));
  fs.rmSync(scratch, { recursive: true, force: true });
}
