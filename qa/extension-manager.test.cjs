const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { archive, manifest } = require('./extension-fixtures.cjs');
const { sha256 } = require('../src/extensions/inspect-package.cjs');
const { openWorkbench, replaceEditor } = require('./desktop-workbench.cjs');

const id = 'org.cevra.manager-test';
const title = 'Studio Palette';
const packageBytes = version => archive({
  ...manifest({ themes: [{ id: 'studio', label: 'Studio', colors: { background: '#102030', foreground: '#F0F8FF', accent: '#79DCBA' } }] }),
  id, version, displayName: title, description: 'Review <button>literal package text</button>.',
});

function manager(page) {
  const dialog = page.getByRole('dialog', { name: 'Extension Manager', exact: true });
  return {
    dialog,
    open: page.getByRole('button', { name: 'Extensions', exact: true }),
    button: name => dialog.getByRole('button', { name, exact: true }),
    entry: dialog.getByRole('listitem', { name: title, exact: true }),
    status: dialog.locator('#extension-manager-status'),
  };
}

async function selectPackage(workbench, file) {
  await workbench.app.evaluate(({ dialog }, { file, project }) => {
    dialog.showOpenDialog = async (_owner, options) => options.title === 'Choose an extension package' ?
      { canceled: !file, filePaths: file ? [file] : [] } : { canceled: false, filePaths: [project] };
  }, { file, project: workbench.project });
}

function packages(page) {
  return page.evaluate(async () => (await window.cevra.extensionRuntime()).catalog);
}

async function install(ui, update = false) {
  await ui.button('Choose ZIP Package').click();
  await ui.button(update ? 'Install Update' : 'Install Package').click();
  await ui.entry.getByText('Disabled', { exact: true }).waitFor();
}

test('a keyboard-only package review works before opening a workspace and preserves explicit enablement',
  { timeout: 35_000 }, async t => {
    let workbench = await openWorkbench(t, { 'entry.js': 'const value = 1;\n' });
    const file = path.join(path.dirname(workbench.profile), 'studio café (#%).zip');
    const bytes = packageBytes('1.0.0');
    await fs.writeFile(file, bytes);
    workbench = await workbench.restart();
    const { page } = workbench;
    await selectPackage(workbench, file);
    const ui = manager(page);
    await page.getByRole('heading', { name: 'Your project starts here.' }).waitFor();
    await ui.open.press('Enter');
    await ui.dialog.getByText('No extensions installed.', { exact: true }).waitFor();
    assert.equal(await ui.button('Choose ZIP Package').evaluate(button => document.activeElement === button), true);
    await page.keyboard.press('Enter');
    const heading = ui.dialog.getByRole('heading', { name: 'Review Studio Palette', exact: true });
    await heading.waitFor();
    assert.equal(await heading.evaluate(node => document.activeElement === node), true);
    await ui.dialog.getByText(path.basename(file), { exact: true }).waitFor();
    await ui.dialog.getByText(sha256(bytes), { exact: true }).waitFor();
    await ui.dialog.getByText('Review <button>literal package text</button>.', { exact: true }).waitFor();
    assert.equal(await ui.dialog.getByRole('button', { name: 'literal package text', exact: true }).count(), 0);
    assert.deepEqual(await packages(page), []);
    await page.keyboard.press('Escape');
    await ui.button('Choose ZIP Package').waitFor();
    assert.equal(await ui.button('Choose ZIP Package').evaluate(button => document.activeElement === button), true);
    await page.keyboard.press('Enter');
    await heading.waitFor();
    const apply = ui.button('Install Package');
    for (let attempt = 0; attempt < 6 && !await apply.evaluate(node => document.activeElement === node); attempt++) {
      await page.keyboard.press('Tab');
    }
    assert.equal(await apply.evaluate(node => document.activeElement === node), true);
    await page.keyboard.press('Enter');
    await ui.entry.getByText('Disabled', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.cevra.extensionContributions()), { packages: [], palette: null });

    await ui.entry.getByRole('button', { name: 'Inspect', exact: true }).press('Enter');
    await ui.dialog.getByText('Local ZIP package', { exact: true }).waitFor();
    await ui.dialog.getByText('No runtime permissions requested.', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await ui.entry.getByRole('button', { name: 'Enable', exact: true }).press('Enter');
    await ui.entry.getByText('Enabled', { exact: true }).waitFor();
    await page.waitForFunction(async () => (await window.cevra.extensionContributions()).packages.length === 1);
    await ui.entry.getByRole('button', { name: 'Quarantine', exact: true }).click();
    await ui.entry.getByText('Quarantined', { exact: true }).waitFor();
    assert.equal(await ui.entry.getByRole('button', { name: 'Enable', exact: true }).count(), 0);
    await ui.entry.getByRole('button', { name: 'Clear Quarantine', exact: true }).click();
    await ui.entry.getByText('Disabled', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await ui.dialog.waitFor({ state: 'hidden' });
  });

test('package picker cancellation and changed update bytes leave the active version intact',
  { timeout: 35_000 }, async t => {
    const workbench = await openWorkbench(t, { 'entry.js': 'const value = 1;\n' });
    const { page, app, profile } = workbench;
    const ui = manager(page);
    const file = path.join(path.dirname(profile), 'studio.zip');
    const first = packageBytes('1.0.0');
    const second = packageBytes('2.0.0');
    await ui.open.click();
    await selectPackage(workbench, null);
    await ui.button('Choose ZIP Package').click();
    await ui.dialog.getByText('No extensions installed.', { exact: true }).waitFor();
    await fs.writeFile(file, Buffer.from('invalid ZIP'));
    await selectPackage(workbench, file);
    await ui.button('Choose ZIP Package').click();
    await ui.status.getByText(/choose a v1 ZIP/i).waitFor();
    await fs.writeFile(file, first);
    await install(ui);
    await ui.entry.getByRole('button', { name: 'Enable', exact: true }).click();
    await ui.entry.getByText('Enabled', { exact: true }).waitFor();
    await fs.writeFile(file, second);
    await ui.button('Choose ZIP Package').click();
    await ui.dialog.getByText('Installed version', { exact: true }).waitFor();
    await ui.dialog.getByText(sha256(second), { exact: true }).waitFor();
    await fs.writeFile(file, packageBytes('3.0.0'));
    await ui.button('Install Update').click();
    await ui.status.getByText(/bytes changed after review/i).waitFor();
    const [active] = await packages(page);
    assert.equal(active.sha256, sha256(first));
    assert.equal(active.enabled, true);
    await ui.button('Back to Installed').click();

    await fs.writeFile(file, second);
    await install(ui, true);
    assert.equal((await packages(page))[0].sha256, sha256(second));
    await ui.entry.getByRole('button', { name: 'Restore Previous Version', exact: true }).click();
    await ui.status.getByText('Version 1.0.0 restored and disabled.', { exact: true }).waitFor();
    assert.equal((await packages(page))[0].sha256, sha256(first));
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await ui.entry.getByRole('button', { name: 'Uninstall', exact: true }).click();
    await ui.status.getByText('Action canceled.', { exact: true }).waitFor();
    assert.equal((await packages(page)).length, 1);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await ui.entry.getByRole('button', { name: 'Uninstall', exact: true }).click();
    await ui.dialog.getByText('No extensions installed.', { exact: true }).waitFor();
    assert.deepEqual(await packages(page), []);
  });

test('safe mode restart uses the normal draft backup and keeps installed enablement',
  { timeout: 45_000 }, async t => {
    const original = 'const value = 1;\n';
    const draft = 'const value = 42;\n';
    let workbench = await openWorkbench(t, { 'entry.js': original });
    const file = path.join(path.dirname(workbench.profile), 'studio.zip');
    const relaunch = path.join(workbench.profile, 'relaunch-arguments.json');
    await fs.writeFile(file, packageBytes('1.0.0'));
    await selectPackage(workbench, file);
    let ui = manager(workbench.page);
    await ui.open.click();
    await install(ui);
    await ui.entry.getByRole('button', { name: 'Enable', exact: true }).click();
    await ui.entry.getByText('Enabled', { exact: true }).waitFor();
    await ui.button('Close').click();
    await workbench.open('entry.js');
    await replaceEditor(workbench, draft);

    async function recordRelaunch(response) {
      await workbench.app.evaluate(({ app, dialog }, { file, response }) => {
        dialog.showMessageBoxSync = () => response;
        app.relaunch = ({ args }) => process.getBuiltinModule('node:fs').writeFileSync(file, JSON.stringify(args));
      }, { file: relaunch, response });
    }
    await recordRelaunch(0);
    await ui.open.click();
    await ui.button('Restart in Safe Mode').click();
    await workbench.page.waitForFunction(() => !document.body.inert && !document.getElementById('extension-manager-restart').disabled);
    await assert.rejects(fs.access(relaunch), { code: 'ENOENT' });
    await recordRelaunch(1);
    workbench = await workbench.restart({ args: ['--disable-extensions'], close: () => ui.button('Restart in Safe Mode').click() });
    const args = JSON.parse(await fs.readFile(relaunch, 'utf8'));
    assert.ok(args.includes('--user-data-dir=' + workbench.profile));
    assert.equal(args.filter(arg => arg === '--disable-extensions').length, 1);
    await workbench.selected('entry.js').waitFor();
    ui = manager(workbench.page);
    await ui.open.click();
    await ui.dialog.getByText(/Safe mode is active/).waitFor();
    await ui.entry.getByText('Enabled', { exact: true }).waitFor();
    assert.deepEqual(await workbench.page.evaluate(() => window.cevra.extensionContributions()), { packages: [], palette: null });
    assert.deepEqual(await workbench.editor.locator('.cm-line').allTextContents(), draft.split('\n'));
    assert.equal(await fs.readFile(path.join(workbench.project, 'entry.js'), 'utf8'), original);

    await recordRelaunch(1);
    workbench = await workbench.restart({ close: () => ui.button('Restart with Extensions').click() });
    const normalArgs = JSON.parse(await fs.readFile(relaunch, 'utf8'));
    assert.ok(normalArgs.includes('--user-data-dir=' + workbench.profile));
    assert.ok(!normalArgs.some(arg => /^--disable-extensions(?:=|$)/.test(arg)));
    await workbench.selected('entry.js').waitFor();
    await workbench.page.waitForFunction(async () => (await window.cevra.extensionContributions()).packages.length === 1);
  });

test('a damaged registry has a visible error and still offers safe mode', { timeout: 25_000 }, async t => {
  const workbench = await openWorkbench(t, { 'entry.js': 'const value = 1;\n' }, async (_project, profile) => {
    const folder = path.join(profile, 'extensions');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'registry.json'), 'damaged snapshot');
  });
  const ui = manager(workbench.page);
  await ui.open.click();
  await ui.dialog.getByRole('alert').getByText('The extension registry is unreadable or damaged.', { exact: true }).waitFor();
  assert.equal(await ui.dialog.getByText('No extensions installed.', { exact: true }).isVisible(), false);
  assert.equal(await ui.button('Restart in Safe Mode').isEnabled(), true);
});
