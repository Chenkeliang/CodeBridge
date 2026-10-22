import fs from 'node:fs';
import path from 'node:path';
import { repositoryRoot, readWorkspacePackages, checkVersions } from './package-release.mjs';

if (process.argv.includes('--check')) {
  const { manifest } = checkVersions(repositoryRoot);
  console.log(`All workspace versions match ${manifest.version}`);
} else {
  const { version } = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  for (const { directory, manifest } of readWorkspacePackages(repositoryRoot)) {
    if (manifest.version === version) continue;
    manifest.version = version;
    fs.writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(`Workspace versions synchronized to ${version}`);
}
