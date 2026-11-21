const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { _electron } = require('playwright');
const { temporaryFolder } = require('./temp.cjs');
const { buildVaultProbe, vaultProbe } = require('./credential-vault-probe.cjs');
const { buildMsi, msiVersion, validateMsi } = require('../scripts/build-windows-installer.cjs');
const { prepareUpdate } = require('../src/windows-update.cjs');
const { createDraftStore } = require('../src/drafts.cjs');
const product = require('../packaging/windows/product.json');

const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const scope = process.env.VOKRI_TEST_INSTALLER_SCOPE;
const stage = process.env.VOKRI_TEST_INSTALLER_STAGE;
const enabled = process.platform === 'win32' && ['account', 'machine'].includes(scope);
const windows = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const msiexec = path.join(windows, 'msiexec.exe');
const reg = path.join(windows, 'reg.exe');
const key = 'Software\\Vokri\\Installer';
const capabilities = 'Software\\Vokri\\WindowsIntegration\\Capabilities';

async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function registry(hive, location, value) {
  try { return (await run(reg, ['query', `${hive}\\${location}`, '/v', value, '/reg:64'], { windowsHide: true })).stdout; }
  catch (error) { if (error.code === 1) return ''; throw error; }
}

test('Windows Installer versions follow the three-field MSI limits', () => {
  for (const input of ['0.1.0', '255.255.65535', '2.0.12']) assert.equal(msiVersion(input), true);
  for (const input of ['01.2.3', '256.1.0', '1.256.0', '1.0.65536', '1.0.0-beta', '1.0.0.0', null]) {
    assert.equal(msiVersion(input), false, String(input));
  }
  return assert.rejects(prepareUpdate('unused.msi', { signer: '' }, '0.1.0'), /no configured publisher/);
});

test('real Windows Installer installs, repairs, updates, rolls back, and removes the editor',
  { skip: !enabled, timeout: 900_000 }, async t => {
    assert.match(stage ?? '', /^[a-z0-9][a-z0-9-]{0,35}$/i, 'Set an existing staged preview name.');
    const staged = path.join(root, 'dist', 'windows-integration', stage);
    const reports = path.join(root, 'dist', 'windows-installer', 'tests', scope + '-' + randomUUID().slice(0, 8));
    const scratch = await temporaryFolder(t, 'vokri-g11-');
    const profile = path.join(scratch, 'profile');
    const project = path.join(scratch, 'project cafés & test');
    const file = path.join(project, 'source % 日本語.js');
    const source = 'const installed = true;\n';
    const draftProject = path.join(scratch, 'draft-project');
    const draftSource = path.join(draftProject, 'unsaved.js');
    const personalFiles = new Map([[file, source],
      [draftSource, source],
      [path.join(profile, 'test-profile.keep'), 'profile data']]);
    for (const [name, data] of personalFiles) {
      await fs.mkdir(path.dirname(name), { recursive: true });
      await fs.writeFile(name, data);
    }
    const drafts = createDraftStore(path.join(profile, 'drafts'));
    await drafts.set(draftProject, 'unsaved.js', 'const unsaved = true;\n', createHash('sha256').update(source).digest('hex'));
    const originalDrafts = await drafts.list();
    buildVaultProbe();
    const credential = [createHash('sha256').update((await fs.realpath(profile)).toLowerCase()).digest('hex'),
      'openai', randomUUID(), 'first'];
    assert.equal(await vaultProbe('seed', ...credential), 0);
    t.after(async () => { assert.equal(await vaultProbe('delete', ...credential), 0); });
    const hive = scope === 'machine' ? 'HKLM' : 'HKCU';
    const other = hive === 'HKLM' ? 'HKCU' : 'HKLM';
    const target = path.join(scope === 'machine' ? process.env.ProgramFiles : path.join(process.env.LOCALAPPDATA, 'Programs'), 'VOKRI Code');
    assert.equal(await exists(target), false, 'Use a clean installation target.');
    for (const location of [hive, other]) {
      assert.equal(await registry(location, key, 'Scope'), '', 'Refusing to modify an existing installation.');
      assert.equal(await registry(location, capabilities, 'VokriRegistrationOwner'), '', 'Use a clean Explorer registration.');
    }
    const base = '0.1.0';
    const next = '0.1.1';
    const builds = new Map();
    await fs.mkdir(reports, { recursive: true });
    for (const [version, fault] of [[base, false], [next, false], ['0.1.2', true]]) {
      const msi = path.join(reports, `${version}.msi`);
      builds.set(version, { msi, ...await buildMsi({ version, scopeName: scope, stage: staged, output: msi, fault }) });
    }
    await validateMsi(builds.get(base).msi, scope);
    const id = version => `{${builds.get(version).productCode}}`;
    const notes = [];
    async function install(operation, args, expected = [0]) {
      const log = path.join(reports, `${operation}.log`);
      let code = 0;
      try { await run(msiexec, [...args, '/qn', '/norestart', '/L*v', log], { windowsHide: true, timeout: 120_000 }); }
      catch (error) { code = error.code; }
      notes.push({ operation, code });
      assert.ok(expected.includes(code), `${operation} exited with ${code}. See ${log}`);
      return fs.readFile(log, 'utf8');
    }
    const manifest = path.join(target, 'resources', 'app', 'package.json');
    const appVersion = async () => JSON.parse(await fs.readFile(manifest, 'utf8')).version;
    const preserved = async () => {
      for (const [name, data] of personalFiles) assert.equal(await fs.readFile(name, 'utf8'), data);
      assert.deepEqual(await drafts.list(), originalDrafts);
      assert.equal(await vaultProbe('verify', ...credential), 0);
    };
    const verifyApp = async expected => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_TEST_CONTEXT;
      const app = await _electron.launch({ executablePath: path.join(target, 'VokriCode.exe'),
        args: ['--user-data-dir=' + profile, '--vokri-open', '--', file], env, cwd: scratch, chromiumSandbox: true, timeout: 30_000 });
      try {
        assert.equal(await app.evaluate(({ app: desktop }) => desktop.getVersion()), expected);
        const page = await app.firstWindow();
        page.setDefaultTimeout(12_000);
        await page.locator('#tabs [aria-current="true"]').getByText(path.basename(file), { exact: true }).waitFor();
        assert.match(await page.getByRole('textbox', { name: 'Source editor' }).textContent(), /const installed = true/);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByText('Signed updates are unavailable in this preview.').waitFor();
        assert.equal(await page.locator('#windows-install-update').isDisabled(), true);
      } finally { await app.close(); }
    };
    try {
      const packageHash = createHash('sha256').update(await fs.readFile(builds.get(next).msi)).digest('hex');
      assert.equal(packageHash, builds.get(next).package.sha256);
      await assert.rejects(prepareUpdate(builds.get(next).msi, { ...product[scope], signer: 'A'.repeat(40) }, base), /against the VOKRI Code publisher/);
      const broken = path.join(scratch, 'truncated.msi');
      await fs.writeFile(broken, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
      await install('broken-package', ['/i', broken], [1619, 1620]);
      assert.equal(await exists(target), false);
      await install('install', ['/i', builds.get(base).msi, 'ADDLOCAL=Core,DesktopShortcut,Explorer']);
      assert.equal(await appVersion(), base);
      assert.match(await registry(hive, key, 'Version'), /0\.1\.0/);
      assert.match(await registry(hive, capabilities, 'VokriRegistrationOwner'), /Vokri\.Code\.Installer/);
      assert.equal(await registry(other, key, 'Scope'), '');
      await verifyApp(base);

      const icon = path.join(target, 'resources', 'app', 'assets', 'brand', 'vc.ico');
      await fs.unlink(icon);
      await install('repair', ['/fa', id(base)]);
      assert.equal(await exists(icon), true);
      await install('upgrade', ['/i', builds.get(next).msi]);
      assert.equal(await appVersion(), next);
      assert.match(await registry(hive, capabilities, 'VokriRegistrationOwner'), /Vokri\.Code\.Installer/);
      await preserved();

      const rollback = await install('failed-upgrade', ['/i', builds.get('0.1.2').msi], [1603]);
      assert.match(rollback, /Deliberate failure while verifying upgrade rollback/);
      assert.equal(await appVersion(), next);
      assert.match(await registry(hive, key, 'Version'), /0\.1\.1/);
      await verifyApp(next);
      const downgrade = await install('downgrade', ['/i', builds.get(base).msi], [1603]);
      assert.match(downgrade, /A newer version of VOKRI Code is already installed/);
      await install('uninstall', ['/x', id(next)]);
      assert.equal(await exists(target), false);
      assert.equal(await registry(hive, key, 'Scope'), '');
      assert.equal(await registry(hive, capabilities, 'VokriRegistrationOwner'), '');
      await preserved();
    } finally {
      try {
        for (const version of ['0.1.2', next, base]) await install(`cleanup-${version}`, ['/x', id(version)], [0, 1605]);
      } finally {
        await fs.writeFile(path.join(reports, 'lifecycle.json'), JSON.stringify({ scope, os: os.release(), operations: notes }, null, 2) + '\n');
        t.diagnostic(reports);
      }
    }
  });
