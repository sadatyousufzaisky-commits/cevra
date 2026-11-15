const fs = require('node:fs');
const path = require('node:path');
const { describePackage } = require('../src/extensions/inspect-package.cjs');
const { packExtensionZip } = require('../src/extensions/package-zip.cjs');

const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'assets', 'extension-store');
const curated = [
  { example: 'starter-tools', category: 'Editing' },
  { example: 'hello-command', category: 'Commands', executable: true },
];

const releases = curated.map(({ example, category, executable }) => {
  const source = path.join(root, 'examples', 'extensions', example);
  const manifest = Buffer.from(fs.readFileSync(path.join(source, 'extension.json'), 'utf8').replaceAll('\r\n', '\n'));
  const module = executable ? fs.readFileSync(path.join(root, 'dist', 'extension-examples', example, 'extension.wasm')) : undefined;
  const archive = packExtensionZip(manifest, module);
  const { sha256, manifest: { id, version, displayName, description, schemaVersion } } = describePackage(archive);
  return { archive, entry: { id, version, displayName, description, category, executable: schemaVersion === 2, sha256 } };
});

fs.mkdirSync(destination, { recursive: true });
for (const { archive, entry } of releases) {
  fs.writeFileSync(path.join(destination, entry.id + '-' + entry.version + '.zip'), archive);
}
fs.writeFileSync(path.join(destination, 'catalog.json'),
  JSON.stringify({ schemaVersion: 1, releases: releases.map(({ entry }) => entry) }, null, 2) + '\n');
