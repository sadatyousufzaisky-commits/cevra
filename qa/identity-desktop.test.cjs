const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { _electron } = require('playwright');
const { createDraftStore } = require('../src/drafts.cjs');
const { createPreferences } = require('../src/preferences.cjs');
const { acquireProfileLease } = require('../src/profile-lease.cjs');
const { selectWorkbenchTheme } = require('./desktop-workbench.cjs');
const { createWorkspace, readSource } = require('../src/workspace.cjs');
const { createExtensionRegistry } = require('../src/extensions/registry.cjs');
const { sha256 } = require('../src/extensions/inspect-package.cjs');
const { archive, manifest } = require('./extension-fixtures.cjs');
const { createWindowsCredentialVault } = require('../src/intelligence/credential-vault-win.cjs');
const { buildVaultProbe, vaultProbe } = require('./credential-vault-probe.cjs');
const { temporaryFolder } = require('./temp.cjs');
const { compile, until } = require('./vokri-support.cjs');

const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const windows = process.platform === 'win32' && process.arch === 'x64';
const source = 'const fixture = "saved";\n';
const draft = 'const fixture = "recovered";\n';

async function writeBootstrap(appData, appRoot, beforeMain = '') {
  const bootstrap = path.join(appData, 'launch.cjs');
  // Electron on Windows resolves Roaming AppData through the shell, independent of the APPDATA environment variable.
  await fs.writeFile(bootstrap, `const { app, dialog } = require('electron');\n` +
    `app.setPath('appData', ${JSON.stringify(appData)});\n${beforeMain}\nrequire(${JSON.stringify(path.join(appRoot, 'src/main.cjs'))});\n`);
  await fs.writeFile(path.join(appData, 'package.json'), JSON.stringify({ name: 'vokri-code', main: 'launch.cjs', version: '0.1.0' }));
}

function electronEnvironment() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function start(appData, args = [], appRoot = root) {
  await writeBootstrap(appData, appRoot);
  const app = await _electron.launch({ executablePath: require('electron'),
    args: [appData, ...args], cwd: root, env: electronEnvironment(), chromiumSandbox: true, timeout: 15_000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 1;
    dialog.showMessageBox = async (_parent, { title, detail, icon }) => {
      globalThis.identityAbout = { title, detail, icon: !icon?.isEmpty() };
      return { response: 0 };
    };
  });
  return { app, page };
}

test('Windows hands an existing profile and its drafts between the native and Electron workbenches',
  { skip: !windows || process.env.VOKRI_TEST_PROFILE_HANDOFF !== '1', timeout: 75_000 }, async t => {
    const appData = await temporaryFolder(t, 'vokri-profile-handoff-');
    const profile = path.join(appData, 'CEVRA');
    const alias = path.join(appData, 'Profile alias');
    const folder = path.join(appData, 'workspace café');
    const entry = path.join(folder, 'app.js');
    const updatedDraft = '/* Native draft */ ';
    await fs.mkdir(folder);
    await fs.writeFile(entry, source);
    const project = await createWorkspace(folder);
    const preferences = createPreferences(profile);
    await preferences.setTheme('midnight');
    await preferences.setEditor(project, 'workspace', { fontSize: 21, wrap: true, indentWidth: 4 });
    const preferencesFile = path.join(profile, 'preferences.json');
    const originalPreferences = await fs.readFile(preferencesFile);
    await createDraftStore(path.join(profile, 'drafts')).set(project.root, 'app.js', draft, (await readSource(project, 'app.js')).revision);
    await fs.symlink(profile, alias, 'junction');
    await execute(process.execPath, [path.join(root, 'scripts', 'build-vokri.cjs')], { timeout: 20_000, windowsHide: true });
    const probe = await compile('Vokri.ProfileProbe', 'vokri-probe.cs', []);
    const native = path.join(root, 'dist', 'vokri', 'Vokri.Cevra.exe');

    async function withNative(directory, run) {
      const child = spawn(native, [process.execPath, root, directory], { cwd: root, stdio: 'ignore' });
      const exited = once(child, 'exit');
      void exited.catch(() => {});
      const query = async (...args) => (await execute(probe, [child.pid, ...args], { timeout: 12_000, windowsHide: true })).stdout;
      try { await run(child, query, exited); }
      finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited.catch(() => {});
      }
    }

    async function waitForRelease() {
      await until(async () => {
        try {
          const lease = await acquireProfileLease(profile);
          await lease.release();
          return true;
        } catch (error) {
          if (error.code !== 'PROFILE_BUSY') throw error;
          return false;
        }
      }, Boolean, 'The profile stayed locked after the workbench exited.');
    }

    const first = await start(appData);
    try {
      await first.page.getByRole('textbox', { name: 'Source editor' }).getByText('recovered', { exact: false }).waitFor();
      await withNative(alias, async (_child, query, exited) => {
        await query('wait', 'This profile is already open.');
        await query('close');
        assert.deepEqual(await exited, [0, null]);
      });
    } finally { await first.app.close(); }
    await waitForRelease();

    await withNative(profile, async (child, query, exited) => {
      await query('wait', 'Recovered 1 draft.');
      assert.match(await query('editor'), /const fixture = "recovered";/);
      await writeBootstrap(appData, root, 'dialog.showErrorBox = () => {};');
      await assert.rejects(execute(require('electron'), [appData], {
        cwd: root, env: electronEnvironment(), timeout: 12_000, windowsHide: true,
      }), error => error.code === 1 && /PROFILE_BUSY/.test(error.stderr));
      await query('type', updatedDraft);
      await query('wait', 'Draft backed up.');
      child.kill('SIGKILL');
      assert.deepEqual(await exited, [null, 'SIGKILL']);
    });
    await waitForRelease();

    const last = await start(appData);
    try {
      const editor = last.page.getByRole('textbox', { name: 'Source editor' });
      await editor.getByText('Native draft', { exact: false }).waitFor();
      assert.match(await editor.innerText(), /recovered/);
      assert.equal(await last.page.locator('#theme-choice').inputValue(), 'midnight');
      await last.page.getByRole('button', { name: 'Settings', exact: true }).click();
      await last.page.locator('input[name="fontSize"]:enabled').waitFor();
      assert.equal(await last.page.getByLabel('Font size', { exact: true }).inputValue(), '21');
    } finally { await last.app.close(); }
    assert.deepEqual(await fs.readFile(preferencesFile), originalPreferences);
    assert.equal(await fs.readFile(entry, 'utf8'), source);
    await assert.rejects(fs.access(path.join(appData, 'VOKRI Code')), { code: 'ENOENT' });
  });

test('Windows shows VOKRI Code identity and uses a branded profile on first launch', { skip: !windows, timeout: 25_000 }, async t => {
  const appData = await temporaryFolder(t, 'vokri-identity-fresh-');
  const { app, page } = await start(appData);
  try {
    await page.waitForFunction(() => !document.getElementById('open-folder').disabled);
    assert.equal(await page.title(), 'VOKRI Code');
    assert.equal(await page.locator('.brand').innerText(), 'VOKRI Code');
    assert.equal(await page.locator('.brand img').evaluate(image => image.complete && image.naturalWidth > 0), true);
    assert.deepEqual(await app.evaluate(({ app, BrowserWindow }) => ({ name: app.getName(), title: BrowserWindow.getAllWindows()[0].getTitle(),
      profile: app.getPath('userData') })), { name: 'VOKRI Code', title: 'VOKRI Code', profile: path.join(appData, 'VOKRI Code') });
    await page.mouse.move(4, 4);
    const screenshots = process.env.VOKRI_IDENTITY_SCREENSHOTS;
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'workbench-dark.png') });
    assert.equal(await page.locator('#welcome-open').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(176, 166, 255)');
    await selectWorkbenchTheme(page, 'light');
    await page.waitForFunction(() => document.documentElement.dataset.colorMode === 'light');
    assert.equal(await page.locator('#welcome-open').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(87, 64, 184)');
    await assert.rejects(fs.access(path.join(appData, 'CEVRA')), { code: 'ENOENT' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'workbench-light.png') });
    await page.getByRole('button', { name: 'About VOKRI Code', exact: true }).press('Enter');
    for (let attempt = 0; attempt < 20 && !await app.evaluate(() => globalThis.identityAbout); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.deepEqual(await app.evaluate(() => globalThis.identityAbout), { title: 'About VOKRI Code', detail: 'Version 0.1.0', icon: true });
    await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close', exact: true }).press('Enter');
    const shortcut = await app.evaluate(({ shell }, { file, directory }) => {
      const icon = process.getBuiltinModule('node:path').join(directory, 'assets', 'brand', 'vc.ico');
      if (!shell.writeShortcutLink(file, 'create', { target: process.execPath, args: '"' + directory + '"',
        description: 'VOKRI Code', icon, iconIndex: 0, appUserModelId: 'Vokri.Code' })) throw new Error('Could not write the test shortcut.');
      return shell.readShortcutLink(file);
    }, { file: path.join(appData, 'VOKRI Code.lnk'), directory: root });
    assert.equal(shortcut.appUserModelId, 'Vokri.Code');
    assert.equal(shortcut.description, 'VOKRI Code');
    assert.equal(path.basename(shortcut.icon), 'vc.ico');
  } finally { await app.close(); }
});

test('Windows reuses the original profile and retains drafts, trust, extensions and vault access through restart',
  { skip: !windows, timeout: 45_000 }, async t => {
    const appData = await temporaryFolder(t, 'vokri-identity-existing-');
    const profile = path.join(appData, 'CEVRA');
    const folder = path.join(appData, 'workspace café');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'app.js'), source);
    await fs.mkdir(path.join(profile, 'intelligence'), { recursive: true });
    const project = await createWorkspace(folder);
    const preferences = createPreferences(profile);
    await preferences.setTheme('light');
    await preferences.setEditor(project, 'global', { fontSize: 19 });
    await preferences.setTrusted(project, true);
    await preferences.setIntelligenceModels({ chat: { providerId: 'openai', modelId: 'gpt-5.6-terra' }, explain: null, patch: null, coding: null });
    await createDraftStore(path.join(profile, 'drafts')).set(project.root, 'app.js', draft, (await readSource(project, 'app.js')).revision);
    const extension = manifest();
    const bytes = archive(extension);
    const digest = sha256(bytes);
    const zip = path.join(appData, 'legacy.zip');
    await fs.writeFile(zip, bytes);
    const registry = createExtensionRegistry(profile);
    await registry.install(zip, { reviewedDigest: digest });
    await registry.setEnabled(extension.id, digest, true);
    const key = randomUUID();
    const scope = createHash('sha256').update((await fs.realpath(profile)).toLowerCase()).digest('hex');
    const metadata = path.join(profile, 'intelligence', 'connections.json');
    const existing = JSON.stringify({ schemaVersion: 1, entries: [{ providerId: 'openai', current: key, pending: null, cleanup: [] }] });
    await fs.writeFile(metadata, existing);
    buildVaultProbe();
    assert.equal(await vaultProbe('seed', scope, 'openai', key, 'first'), 0);
    t.after(() => createWindowsCredentialVault().remove(scope, 'openai', key));

    const launch = async () => {
      const { app, page } = await start(appData, ['--enable-intelligence']);
      try {
        assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
        await page.waitForFunction(() => !document.getElementById('open-folder').disabled);
        await page.getByRole('textbox', { name: 'Source editor' }).getByText('recovered', { exact: false }).waitFor();
        assert.equal(await page.locator('#theme-choice').inputValue(), 'light');
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByText('Workspace execution is trusted.', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('Font size', { exact: true }).inputValue(), '19');
        await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('button', { name: 'Extensions', exact: true }).click();
        await page.getByRole('heading', { name: extension.displayName, exact: true }).waitFor();
        await page.getByRole('dialog', { name: 'Extension Manager' }).getByRole('button', { name: 'Close', exact: true }).click();
        const opened = app.waitForEvent('window');
        await page.getByRole('button', { name: 'VOKRI Intelligence', exact: true }).click();
        const panel = await opened;
        await panel.getByRole('heading', { name: 'VOKRI Intelligence', exact: true }).waitFor();
        await panel.waitForFunction(() => document.documentElement.dataset.colorMode === 'light');
        assert.equal(await panel.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
        await panel.getByText('Provider connections', { exact: true }).click();
        await panel.getByRole('button', { name: 'Check key', exact: true }).click();
        await panel.getByText('Windows Credential Manager verified the stored key.', { exact: true }).waitFor();
        assert.equal(await panel.getByLabel('Model', { exact: true }).inputValue(), 'gpt-5.6-terra');
        const closed = panel.waitForEvent('close');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'VOKRI Intelligence').close());
        await closed;
      } finally { await app.close(); }
    };

    await launch();
    await launch();
    if (process.env.VOKRI_IDENTITY_ROLLBACK_ROOT) {
      const baseline = path.resolve(process.env.VOKRI_IDENTITY_ROLLBACK_ROOT);
      const { app, page } = await start(appData, ['--enable-intelligence'], baseline);
      try {
        assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
        await page.getByRole('textbox', { name: 'Source editor' }).getByText('recovered', { exact: false }).waitFor();
        assert.equal(await page.locator('#theme-choice').inputValue(), 'light');
        const opened = app.waitForEvent('window');
        await page.getByRole('button', { name: 'Intelligence', exact: true }).click();
        const panel = await opened;
        await panel.getByText('Provider connections', { exact: true }).click();
        await panel.getByRole('button', { name: 'Check key', exact: true }).click();
        await panel.getByText('Windows Credential Manager verified the stored key.', { exact: true }).waitFor();
        const closed = panel.waitForEvent('close');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'CEVRA Intelligence').close());
        await closed;
      } finally { await app.close(); }
    }
    assert.equal(await fs.readFile(metadata, 'utf8'), existing);
    assert.equal(await vaultProbe('verify', scope, 'openai', key, 'first'), 0);
    assert.equal(await fs.readFile(path.join(folder, 'app.js'), 'utf8'), source);
    await assert.rejects(fs.access(path.join(appData, 'VOKRI Code')), { code: 'ENOENT' });
  });
