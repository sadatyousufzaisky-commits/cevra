const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { activationArguments, explorerPlans, localPath, verifyExplorerPlan } = require('../src/explorer-activation.cjs');
const { createWorkspace } = require('../src/workspace.cjs');
const { types } = require('../src/windows-file-types.json');

const root = path.resolve(__dirname, '..');
const run = promisify(execFile);
const windows = process.platform === 'win32';

test('G10 treats Explorer arguments as paths only after the activation separator', () => {
  assert.deepEqual(activationArguments(['app.exe', '--vokri-open', '--', 'C:\\café & (50%)\\source.ts']), ['C:\\café & (50%)\\source.ts']);
  assert.deepEqual(activationArguments(['app.exe', '--vokri-open', 'C:\\source.js']), []);
  assert.equal(localPath('x.js', 'D:\\project'), 'D:\\project\\x.js');
  assert.equal(localPath('\\\\?\\C:\\long\\sample.py'), 'C:\\long\\sample.py');
  for (const input of ['\\\\.\\pipe\\x.js', '\\\\host\\share\\x.js', 'D:a.js', 'FILE:///D:/a.js',
    'C:\\x.js:alternate', '..\\x.js', '.\\x.js', 'D:\\folder.\\x.js', 'D:\\con.js', 'C:\\code\\.git\\x.js',
    'C:\\x\\bad" quote.js', '--disable-extensions']) {
    assert.throws(() => localPath(input, 'C:\\code'), /unavailable/);
  }
});

test('G10 rechecks a selected file identity before the open is committed', { skip: !windows }, async t => {
  const temporary = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(temporary, 'vokri-g10-identity-'));
  t.after(async () => {
    const resolved = await fs.realpath(folder);
    assert.equal(path.dirname(resolved), temporary);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const file = path.join(folder, 'source.js');
  await fs.writeFile(file, 'const correct = true;\n');
  const workspace = await createWorkspace(folder);
  const { plans: [plan], rejected } = await explorerPlans([{ input: file }], workspace);
  assert.equal(rejected, 0);
  assert.deepEqual(await verifyExplorerPlan(plan, workspace), ['source.js']);
  await fs.rename(file, path.join(folder, 'original.js'));
  await fs.writeFile(file, 'const replacement = true;\n');
  await assert.rejects(verifyExplorerPlan(plan, workspace), /changed or is unavailable/);
});

test('G10 document icons have seven valid Windows icon sizes and cover each association category', async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(new Set(Object.values(types).flat()).size, Object.values(types).flat().length);
  for (const category of Object.keys(types)) {
    const icon = await fs.readFile(path.join(root, 'assets/brand/documents', category.toLowerCase() + '.ico'));
    assert.equal(icon.readUInt16LE(2), 1);
    assert.equal(icon.readUInt16LE(4), sizes.length);
    let nextOffset = 6 + 16 * sizes.length;
    for (const [index, size] of sizes.entries()) {
      const entry = 6 + 16 * index;
      assert.equal(icon[entry], size % 256);
      assert.equal(icon[entry + 1], size % 256);
      assert.equal(icon.readUInt32LE(entry + 12), nextOffset);
      assert.equal(icon.readUInt32BE(nextOffset + 16), size);
      assert.equal(icon.readUInt32BE(nextOffset + 20), size);
      nextOffset += icon.readUInt32LE(entry + 8);
    }
    assert.equal(nextOffset, icon.length);
  }
});

test('G10 registers, updates and removes only owned Windows association values', { skip: !windows, timeout: 35_000 }, async () => {
  const { stdout } = await run('pwsh', ['-NoProfile', '-File', path.join(root, 'qa/test-windows-integration.ps1')], {
    cwd: root, windowsHide: true, timeout: 30_000,
  });
  assert.match(stdout, /Registry lifecycle verified/);
});
