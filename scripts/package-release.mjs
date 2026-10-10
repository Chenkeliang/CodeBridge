import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readWorkspacePackages(root) {
  return ['apps', 'packages'].flatMap((group) => fs.readdirSync(path.join(root, group))
    .filter((name) => fs.existsSync(path.join(root, group, name, 'package.json')))
    .map((name) => {
      const directory = path.join(root, group, name);
      return { directory, manifest: JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) };
    }));
}

export function checkVersions(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const workspaces = readWorkspacePackages(root);
  const mismatches = workspaces.filter((item) => item.manifest.version !== manifest.version);
  if (mismatches.length) throw new Error(`Version mismatch: ${mismatches.map((item) => item.manifest.name).join(', ')}; run pnpm version:sync`);
  return { manifest, workspaces };
}

/** Only compiled assets and selected package metadata enter the distributable. */
export function stageRelease(root, stage) {
  const { manifest, workspaces } = checkVersions(root);
  const names = new Set(workspaces.map((item) => item.manifest.name));
  const external = {};
  for (const { directory, manifest: pkg } of workspaces) {
    const output = path.join(stage, 'node_modules', pkg.name);
    const dist = path.join(directory, 'dist');
    if (!fs.existsSync(dist)) throw new Error(`Missing build: ${dist}; run pnpm build`);
    fs.mkdirSync(output, { recursive: true });
    fs.cpSync(dist, path.join(output, 'dist'), {
      recursive: true,
      filter: (source) => !/\.(test|spec)\./.test(path.basename(source)) && !source.endsWith('.map'),
    });
    // Web is already bundled by Vite; its browser dependencies are not server dependencies.
    const dependencies = pkg.name === '@codebridge/web' ? {} : Object.fromEntries(
      Object.entries(pkg.dependencies ?? {}).map(([name, spec]) => {
        if (spec.startsWith('workspace:')) {
          if (!names.has(name)) throw new Error(`Missing workspace dependency: ${name}`);
          return [name, manifest.version];
        }
        const installed = JSON.parse(fs.readFileSync(path.join(directory, 'node_modules', name, 'package.json'), 'utf8')).version;
        if (external[name] && external[name] !== installed) throw new Error(`Conflicting installed versions of ${name}; reconcile the workspace lockfile before packaging`);
        external[name] = installed;
        return [name, installed];
      }),
    );
    const metadata = Object.fromEntries(['name', 'version', 'type', 'main', 'types', 'exports', 'bin', 'engines']
      .filter((key) => pkg[key] !== undefined).map((key) => [key, pkg[key]]));
    fs.writeFileSync(path.join(output, 'package.json'), `${JSON.stringify({ ...metadata, license: manifest.license, dependencies }, null, 2)}\n`);
  }
  const distribution = {
    name: manifest.name, version: manifest.version, description: manifest.description,
    license: manifest.license, engines: manifest.engines,
    repository: { type: 'git', url: 'https://github.com/Chenkeliang/CodeBridge.git' },
    bin: {
      codebridge: 'node_modules/@codebridge/bridge/dist/cli.js',
      'codebridge-runner': 'node_modules/@codebridge/runner-host/dist/cli.js',
    },
    dependencies: { ...external, ...Object.fromEntries([...names].sort().map((name) => [name, manifest.version])) },
    bundleDependencies: [...names].sort(),
    files: ['README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md',
      'docs/zh-CN/npm-release.md', 'apps/web/public/brand/agent-logo.svg', 'apps/web/public/brand/agent-logo-carbon.svg'],
    publishConfig: { access: 'public' },
  };
  fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(distribution, null, 2)}\n`);
  for (const file of distribution.files) {
    fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(stage, file));
  }
  return distribution;
}

export function packRelease(root = repositoryRoot) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'codebridge-pack-'));
  try {
    stageRelease(root, stage);
    const destination = path.join(root, 'dist');
    fs.mkdirSync(destination, { recursive: true });
    const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], {
      cwd: stage, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    }));
    const artifact = path.join(destination, result[0].filename);
    console.log(artifact);
    return artifact;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packRelease();
