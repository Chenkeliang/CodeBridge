import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { configuredCodexBackends, adapterFingerprint, loadCandidateConfig } from './check-codex-network.mjs';

const args = process.argv.slice(2);
const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (!arg('--config') || !arg('--host')) throw new Error('Usage: pnpm verify:codex-network --config /absolute/candidate.yaml --host reachable-hostname');
const configPath = path.resolve(arg('--config'));
const host = arg('--host');
if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('--host must be a hostname');
const config = await loadCandidateConfig(configPath);
const profiles = configuredCodexBackends(config);
if (!profiles.length) throw new Error('No explicitly configured Codex network_access option to verify');
const { AcpSessionPool, runAcpSession } = await import('../packages/backends/dist/index.js');
const root = fs.mkdtempSync(path.join(os.homedir(), '.codebridge-acp-network-'));
const cwd = path.join(root, 'workspace');
fs.mkdirSync(cwd);
const outside = path.join(root, 'outside.txt');
const receipt = { schemaVersion: 1, verifiedAt: new Date().toISOString(), backends: {} };
try {
  for (const [id, profile] of profiles) {
    const fingerprint = adapterFingerprint(profile);
    fs.writeFileSync(outside, 'BASELINE');
    fs.writeFileSync(path.join(cwd, 'probe.py'), `import socket, pathlib, json
r = {}
connected = False
try:
    socket.getaddrinfo(${JSON.stringify(host)}, 443)
    with socket.create_connection((${JSON.stringify(host)}, 443), timeout=8): pass
    connected = True
except OSError: pass
r['network'] = 'PASS' if connected == ${profile.acpConfig.network_access ? 'True' : 'False'} else 'FAIL'
pathlib.Path('inside.txt').write_text('allowed')
r['workspace_write'] = 'PASS' if pathlib.Path('inside.txt').read_text() == 'allowed' else 'FAIL'
try:
    pathlib.Path(${JSON.stringify(outside)}).write_text('FORBIDDEN')
    r['outside_write_blocked'] = 'FAIL'
except PermissionError: r['outside_write_blocked'] = 'PASS'
print(json.dumps(r))
`);
    let pool = new AcpSessionPool({ enabled: true, idleMs: 60_000, maxPooled: 1 });
    let sessionId;
    const scenarios = {};
    try {
      for (const phase of ['new', 'pooled-resume', 'cold-resume']) {
        if (phase === 'cold-resume') {
          pool.shutdown();
          pool = new AcpSessionPool({ enabled: true, idleMs: 60_000, maxPooled: 1 });
        }
        let permissionRequests = 0;
        const events = [];
        const previousSessionId = sessionId;
        fs.rmSync(path.join(cwd, 'inside.txt'), { force: true });
        for await (const event of runAcpSession({
          runId: crypto.randomUUID(), cwd, backendConfig: profile,
          ...(sessionId ? { resumeSessionId: sessionId } : {}),
          extraEnv: { MLINK_MEMORY: 'off' },
          prompt: `这是已授权的配置验收。只用普通沙箱执行 python3 probe.py 一次并原样报告 JSON。脚本仅对 ${host}:443 做 DNS/TCP 检查，不发送 HTTP 或业务查询，并验证工作区写入和对专用测试文件 ${outside} 的写入拒绝。不要提权、修改脚本、发消息、调用记忆或修复任何失败。`,
        }, {
          permissionPolicy: 'prompt_feishu', isAborted: () => false, sessionPool: pool,
          promptTimeoutMs: 180_000, drainBackgroundWork: false,
          requestDecision: async () => { permissionRequests++; return false; },
        }, {})) {
          events.push(event);
          if (event.type === 'session') sessionId = event.sessionId;
        }
        const outputs = events.filter((event) => event.type === 'tool_end' && event.output?.formatted_output)
          .map((event) => { try { return JSON.parse(event.output.formatted_output); } catch { return null; } });
        const result = outputs.find((value) => value?.network);
        if (!sessionId || (previousSessionId && sessionId !== previousSessionId)
          || events.some((event) => event.type === 'error' && event.fatal)
          || outputs.length !== 1 || result?.network !== 'PASS' || result?.workspace_write !== 'PASS'
          || result?.outside_write_blocked !== 'PASS' || permissionRequests !== 0
          || !fs.existsSync(path.join(cwd, 'inside.txt')) || fs.readFileSync(path.join(cwd, 'inside.txt'), 'utf8') !== 'allowed'
          || fs.readFileSync(outside, 'utf8') !== 'BASELINE') {
          throw new Error(`${id} ${phase}: network/filesystem sandbox acceptance failed (permission requests: ${permissionRequests})`);
        }
        scenarios[phase] = { ...result, permissionRequests };
        console.log(`${id} ${phase}: network PASS, workspace write PASS, outside write blocked PASS, approvals 0`);
      }
    } finally { pool.shutdown(); }
    if (adapterFingerprint(profile) !== fingerprint) throw new Error(`${id}: adapter changed during acceptance`);
    receipt.backends[id] = { fingerprint, sessionId, scenarios };
  }
  const output = path.join(path.dirname(configPath), 'codex-network-acceptance.json');
  const temporary = `${output}.${crypto.randomUUID()}.next`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (fs.existsSync(output)) {
      const backup = `${output}.bak-${Date.now()}-${crypto.randomUUID()}`;
      fs.copyFileSync(output, backup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup, 0o600);
      console.log(`Previous acceptance backup: ${backup}`);
    }
    fs.renameSync(temporary, output);
  } finally { fs.rmSync(temporary, { force: true }); }
  console.log(`Acceptance saved: ${output}`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
