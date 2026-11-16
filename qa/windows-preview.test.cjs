const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { _electron } = require('playwright');
const { temporaryFolder } = require('./temp.cjs');
const { executable } = require('../src/windows-file-types.json');

const run = promisify(execFile);
const repo = path.resolve(__dirname, '..');
const tag = process.env.VOKRI_TEST_WINDOWS_PREVIEW;
const enabled = process.platform === 'win32' && /^[a-z0-9][a-z0-9-]{0,35}$/i.test(tag ?? '');

test('G10 staged preview receives real Windows Shell file and folder activations', { skip: !enabled, timeout: 75_000 }, async t => {
  const preview = path.join(repo, 'dist/windows-integration', tag);
  const appRoot = path.join(preview, 'resources/app');
  const fixture = await temporaryFolder(t, 'vokri-g10-shell-');
  const first = path.join(fixture, 'first');
  const second = path.join(fixture, 'folder cafés & QA');
  const before = path.join(first, 'startup.js');
  const sent = path.join(first, '波型 & 50%.ts');
  await fs.mkdir(first);
  await fs.mkdir(second);
  await Promise.all([
    fs.writeFile(before, 'const startup = true;\n'), fs.writeFile(sent, 'const exact = true;\n'),
    fs.writeFile(path.join(second, 'folder-entry.txt'), 'Folder fixture'),
  ]);
  const ps = (script, ...args) => run('pwsh', ['-NoProfile', '-File', script, ...args], { timeout: 20_000, windowsHide: true });
  const probe = (action, ...args) => ps(path.join(repo, 'qa/windows-shell-probe.ps1'), action, ...args);
  const registration = action => ps(path.join(preview, 'windows-integration.ps1'), action);
  const snapshot = () => probe('Snapshot').then(({ stdout }) => JSON.parse(stdout));
  const original = await snapshot();
  assert.deepEqual(original.Owned, [], 'Use a clean VOKRI Code registration before running this isolated Shell fixture.');
  assert.equal(original.Registered, false);

  const manifestFile = path.join(appRoot, 'package.json');
  const bootstrap = path.join(appRoot, 'shell-test-bootstrap.cjs');
  const manifest = await fs.readFile(manifestFile, 'utf8');
  const appData = path.join(fixture, 'isolated-appdata');
  await fs.mkdir(appData);
  // Every process created by the Windows Shell uses the disposable profile, including secondary launches.
  await fs.writeFile(bootstrap, 'const { app } = require("electron");\n' +
    `app.setPath("appData", ${JSON.stringify(appData)});\nrequire("./src/main.cjs");\n`, { flag: 'wx' });
  let app;
  let registered = false;
  try {
    await fs.writeFile(manifestFile, JSON.stringify({ ...JSON.parse(manifest), main: 'shell-test-bootstrap.cjs' }));
    await registration('Register');
    registered = true;
    assert.deepEqual((await snapshot()).Choices, original.Choices);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_TEST_CONTEXT;
    app = await _electron.launch({ executablePath: path.join(preview, executable), args: ['--vokri-open', '--', before],
      env, cwd: fixture, chromiumSandbox: true, timeout: 20_000 });
    const page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    const active = name => page.locator('#tabs [aria-current="true"]').getByText(name, { exact: true });
    await active('startup.js').waitFor();
    await probe('Launch', '-Preview', preview, '-Target', sent);
    await active(path.basename(sent)).waitFor();
    assert.match(await page.getByRole('textbox', { name: 'Source editor' }).textContent(), /const exact = true/);
    await probe('Launch', '-Preview', preview, '-Target', second);
    await page.getByRole('navigation', { name: 'Project files' }).getByText('folder-entry.txt', { exact: true }).waitFor();
    assert.equal(await fs.readFile(sent, 'utf8'), 'const exact = true;\n');
    assert.equal(app.windows().length, 1);
  } finally {
    try { await app?.close(); } finally {
      try { if (registered) await registration('Unregister'); } finally {
        await fs.writeFile(manifestFile, manifest);
        await fs.unlink(bootstrap);
      }
    }
  }
  const cleaned = await snapshot();
  assert.deepEqual(cleaned, original);
});
