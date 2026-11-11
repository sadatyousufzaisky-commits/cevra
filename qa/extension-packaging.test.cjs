const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { inspectExtensionPackage, sha256 } = require('../src/extensions/inspect-package.cjs');
const { executableManifest, json, manifest, minimalModule } = require('./extension-fixtures.cjs');
const { temporaryFolder } = require('./temp.cjs');

const exec = promisify(execFile);
const script = path.resolve(__dirname, '../scripts/pack-extension.cjs');
const pack = (source, output) => exec(process.execPath, [script, source, output], { windowsHide: true });

test('the packer produces identical inspected ZIPs from the same v1 and v2 source bytes', async t => {
  const root = await temporaryFolder(t, 'cevra-packaging-');
  const left = path.join(root, 'source café (#%)');
  const right = path.join(root, 'other source');
  await fs.mkdir(left);
  await fs.mkdir(right);
  for (const data of [manifest(), executableManifest([{ capability: 'commands.register' }])]) {
    for (const [index, source] of [left, right].entries()) {
      const manifestFile = path.join(source, 'extension.json');
      await fs.writeFile(manifestFile, json(data));
      await fs.writeFile(path.join(source, 'extension.wasm'), minimalModule);
      await fs.writeFile(path.join(source, 'README.txt'), `Different unrelated contents ${index}.`);
      const stamp = new Date(Date.UTC(2005 + index, 0, 1));
      await fs.utimes(manifestFile, stamp, stamp);
    }
    const a = path.join(root, `left-${data.schemaVersion}.zip`);
    const b = path.join(root, `right-${data.schemaVersion}.zip`);
    const [one, two] = await Promise.all([pack(left, a), pack(right, b)]);
    const bytes = await fs.readFile(a);
    assert.deepEqual(bytes, await fs.readFile(b));
    assert.equal(one.stdout, two.stdout);
    const report = await inspectExtensionPackage(a);
    assert.deepEqual(JSON.parse(one.stdout), report);
    assert.equal(report.sha256, sha256(bytes));
    assert.deepEqual(report.manifest, data);
    assert.deepEqual(report.inventory.map(entry => entry.path),
      data.schemaVersion === 1 ? ['extension.json'] : ['extension.json', 'extension.wasm']);
    await assert.rejects(pack(left, a), { code: 1, stderr: /^OUTPUT_EXISTS/ });
    assert.deepEqual(await fs.readFile(a), bytes);
  }
});

test('invalid inputs and incompatible packages produce no ZIP output', async t => {
  const root = await temporaryFolder(t, 'cevra-invalid-package-');
  const input = path.join(root, 'extension.json');
  const output = path.join(root, 'unwritten.zip');
  await fs.writeFile(input, '{invalid');
  await assert.rejects(pack(root, output), { code: 1, stderr: /^INVALID_MANIFEST/ });
  await fs.writeFile(input, json({ ...manifest(), engines: { cevra: '>=2.0.0 <3.0.0' } }));
  await assert.rejects(pack(root, output), { code: 1, stderr: /^INCOMPATIBLE_ENGINE/ });
  await fs.writeFile(input, json(executableManifest([{ capability: 'commands.register' }])));
  await assert.rejects(pack(root, output), { code: 1, stderr: /^PACKAGE_PATH/ });
  await fs.writeFile(path.join(root, 'extension.wasm'), 'bad module');
  await assert.rejects(pack(root, output), { code: 1, stderr: /^INVALID_ARCHIVE/ });
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
});
