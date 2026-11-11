const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { validateManifest } = require('../sdk/extensions/manifest.cjs');
const { maxManifestBytes } = require('../src/extensions/package-zip.cjs');
const { temporaryFolder } = require('./temp.cjs');

const root = path.resolve(__dirname, '..');
const exec = promisify(execFile);
const example = name => path.join(root, 'examples', 'extensions', name, 'extension.json');
const validate = filename => exec(process.execPath, [path.join(root, 'scripts', 'validate-extension.cjs'), filename]);

test('the author CLI and Node SDK validate both checked-in manifests', async () => {
  for (const name of ['starter-tools', 'hello-command']) {
    const bytes = await fs.readFile(example(name));
    const { stdout } = await validate(example(name));
    assert.deepEqual(JSON.parse(stdout), JSON.parse(bytes));
    assert.deepEqual(validateManifest(new Uint8Array(bytes)), JSON.parse(bytes));
  }
});

test('manifest preflight enforces the documented rejection cases and preserves original bytes', async t => {
  const folder = await temporaryFolder(t, 'cevra-sdk-validation-');
  const filename = path.join(folder, 'negative example café.json');
  const bytes = await fs.readFile(example('hello-command'));
  const manifest = JSON.parse(bytes);
  const cases = [
    ['INVALID_MANIFEST', { ...manifest, runtime: { ...manifest.runtime, apiVersion: '1.0' } }],
    ['INVALID_MANIFEST', { ...manifest, permissions: [...manifest.permissions, ...manifest.permissions] }],
    ['INVALID_MANIFEST', { ...manifest, permissions: [{ capability: 'workspace.read', files: ['src/*.js'] }] }],
    ['INCOMPATIBLE_ENGINE', { ...manifest, engines: { cevra: '>=9.0.0 <10.0.0' } }],
    ['INVALID_MANIFEST', Buffer.from('{"schemaVersion":2,' + bytes.toString('utf8').slice(1))],
    ['INVALID_MANIFEST', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])],
    ['PACKAGE_TOO_LARGE', Buffer.alloc(maxManifestBytes + 1, 0x20)],
  ];
  for (const [code, value] of cases) {
    const invalid = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    assert.throws(() => validateManifest(invalid), { code });
    await fs.writeFile(filename, invalid);
    await assert.rejects(validate(filename), { code: 1, stderr: new RegExp('^' + code + ' ') });
  }
});

test('the published TypeScript declarations compile and reject invalid method and manifest shapes', async () => {
  const tsc = require.resolve('typescript/bin/tsc');
  await exec(process.execPath, [tsc, '--strict', '--noEmit', '--module', 'NodeNext', 'qa/extension-sdk-types.cts'], { cwd: root });
});
