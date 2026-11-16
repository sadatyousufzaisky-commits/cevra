const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { openWorkbench, selectWorkbenchTheme } = require('./desktop-workbench.cjs');

function settings(page) {
  return page.getByRole('dialog', { name: 'Settings', exact: true });
}

async function openSettings(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).press('Enter');
  const center = settings(page);
  await center.waitFor();
  return center;
}

const query = center => center.getByRole('searchbox', { name: 'Search settings', exact: true });
const close = center => center.getByRole('button', { name: 'Close', exact: true }).click();
const search = (center, text) => query(center).fill(text);
const field = (center, name) => center.getByLabel(name, { exact: true });
const action = (center, name) => center.getByRole('button', { name, exact: true });
const saved = center => center.locator('#settings-status').getByText('Settings saved.', { exact: true }).waitFor();

async function capture(target, name) {
  const directory = process.env.VOKRI_G9_EVIDENCE_DIR;
  if (!directory) return;
  await fs.mkdir(directory, { recursive: true });
  await target.screenshot({ path: path.join(directory, name + '.png') });
}

test('G9 searches beginner and advanced terms and stays keyboard-readable at 200% zoom', { timeout: 35_000 }, async t => {
  const { app, page, editor, open } = await openWorkbench(t, { 'entry.js': 'const example = 42;\n' });
  await open('entry.js');
  await editor.press('Control+,');
  let center = settings(page);
  await center.waitFor();
  assert.equal(await query(center).evaluate(node => node === document.activeElement), true);
  await search(center, 'HOW can I make the text bigger');
  await center.getByText('1 setting found', { exact: true }).waitFor();
  await field(center, 'Font size').waitFor();
  assert.match(await center.ariaSnapshot(), /spinbutton "Font size"/);
  await capture(center, 'beginner-search');
  await search(center, 'tabSize');
  await field(center, 'Indent width').waitFor();
  await field(center, 'Font size').waitFor({ state: 'hidden' });
  await search(center, 'formatOnSave');
  await field(center, 'Format JavaScript and TypeScript on save').waitFor();
  await search(center, 'not-a-setting');
  await center.getByText('No settings match your search.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await center.waitFor({ state: 'hidden' });

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.unmaximize();
    window.setSize(900, 660);
    window.webContents.setZoomFactor(2);
  });
  center = await openSettings(page);
  await search(center, 'wordWrap');
  await field(center, 'Wrap lines').waitFor();
  await page.waitForFunction(() => {
    const dialog = document.getElementById('settings-dialog');
    const content = dialog.querySelector('.settings-content');
    return window.innerWidth < 600 && dialog.scrollWidth <= dialog.clientWidth &&
      content.scrollWidth <= content.clientWidth && content.clientHeight >= 110;
  });
  await query(center).press('Tab');
  assert.equal(await center.evaluate(node => node.contains(document.activeElement)), true);
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  assert.match(await center.ariaSnapshot(), /checkbox "Wrap lines"/);
  await capture(page, 'advanced-search-200');
  await page.keyboard.press('Escape');
  await center.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#editor-settings').evaluate(node => node === document.activeElement), true);
});

test('G9 restores inherited and global values across restart and exports only portable preferences', { timeout: 45_000 }, async t => {
  let previous;
  let stateFile;
  let workspaceKey;
  const privateMarker = 'SYNTHETIC_PRIVATE_PROFILE_MARKER';
  let workbench = await openWorkbench(t, { 'example.js': 'const wide = true;\n' }, async (project, profile) => {
    workspaceKey = process.platform === 'win32' ? project.toLowerCase() : project;
    stateFile = path.join(profile, 'preferences.json');
    previous = {
      theme: 'midnight', editor: { fontSize: 18, cursor: 'wide', invalid: privateMarker },
      workspaces: { [workspaceKey]: { fontSize: 24, lineNumbers: false, wrap: true } },
      trusted: { [workspaceKey]: { schemaVersion: 1, identity: privateMarker } },
      extensionPalette: privateMarker, extensionCatalog: { generation: 19, digest: privateMarker },
      intelligence: { language: 'en-GB', length: 'concise', style: 'project', testing: 'regression' },
      connectionData: { apiKey: privateMarker },
    };
    await fs.writeFile(stateFile, JSON.stringify(previous));
  });
  await workbench.open('example.js');
  const size = page => page.locator('.cm-editor').evaluate(node => getComputedStyle(node).fontSize);
  assert.equal(await size(workbench.page), '24px');
  let center = await openSettings(workbench.page);
  await search(center, 'execution trust');
  await center.getByText('VOKRI Code will ask before running workspace code.', { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')).trusted, previous.trusted);
  await search(center, 'font size');
  assert.equal(await field(center, 'Font size').inputValue(), '24');
  await action(center, 'Reset Font size').press('Enter');
  assert.equal(await field(center, 'Font size').inputValue(), '18');
  await center.getByText(/Inherits global · 18 px · Unsaved/).waitFor();
  await query(center).press('Escape');
  await center.getByText('Save or discard your editor changes before closing Settings.', { exact: true }).waitFor();
  await field(center, 'Scope').selectOption('global');
  await field(center, 'Font size').fill('35');
  await action(center, 'Save Settings').press('Enter');
  await center.getByText('Font size must be a whole number from 10 to 32.', { exact: true }).waitFor();
  assert.equal(await field(center, 'Font size').getAttribute('aria-invalid'), 'true');
  await field(center, 'Font size').fill('20');
  await action(center, 'Save Settings').press('Enter');
  await saved(center);
  await field(center, 'Scope').selectOption('workspace');
  assert.equal(await field(center, 'Font size').inputValue(), '20');
  await action(center, 'Save Settings').press('Enter');
  await saved(center);
  assert.equal(await size(workbench.page), '20px');
  assert.equal(await workbench.page.locator('#editor').getAttribute('data-line-numbers'), 'false');

  const output = path.join(path.dirname(workbench.profile), 'preferences café.json');
  await search(center, 'export settings');
  await workbench.app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  await action(center, 'Export settings').press('Enter');
  await center.getByText('Export canceled.', { exact: true }).waitFor();
  await workbench.app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, stateFile);
  await action(center, 'Export settings').press('Enter');
  await center.getByText('Choose a folder outside the active profile.', { exact: true }).waitFor();
  await workbench.app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
  await action(center, 'Export settings').press('Enter');
  await center.getByText('Settings exported.', { exact: true }).waitFor();
  const exported = await fs.readFile(output, 'utf8');
  assert.deepEqual(JSON.parse(exported), {
    schemaVersion: 1, appearance: { theme: 'midnight' },
    editor: { fontSize: 20, fontFamily: 'default', indentWidth: 2, indentStyle: 'spaces', wrap: false,
      lineNumbers: true, cursor: 'wide', formatOnSave: false, renameShortcut: 'f2' },
  });
  assert.ok(!exported.includes(privateMarker) && !exported.includes(path.basename(workbench.project)));
  await close(center);
  workbench = await workbench.restart();
  await workbench.page.locator('#open-folder').click();
  await workbench.open('example.js');
  assert.equal(await size(workbench.page), '20px');
  center = await openSettings(workbench.page);
  await search(center, 'font size');
  assert.equal(await action(center, 'Reset Font size').isDisabled(), true);
  await action(center, 'Clear Workspace Overrides').press('Enter');
  await action(center, 'Save Settings').press('Enter');
  await saved(center);
  await field(center, 'Scope').selectOption('global');
  await action(center, 'Restore editor defaults').press('Enter');
  await action(center, 'Save Settings').press('Enter');
  await saved(center);
  await close(center);
  assert.equal(await size(workbench.page), '14px');
  assert.equal(await workbench.page.locator('#editor').getAttribute('data-line-numbers'), 'true');
  await selectWorkbenchTheme(workbench.page, 'light');
  await workbench.page.locator('#appearance-settings').press('Enter');
  center = settings(workbench.page);
  await action(center, 'Reset Theme').press('Enter');
  await center.locator('#settings-status').getByText('Theme saved.', { exact: true }).waitFor();
  await close(center);
  const stored = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(stored.theme, 'dark');
  assert.equal(stored.editor.fontSize, 14);
  assert.equal(stored.workspaces[workspaceKey], undefined);
  for (const name of ['trusted', 'extensionCatalog', 'intelligence', 'connectionData']) assert.deepEqual(stored[name], previous[name]);
  workbench = await workbench.restart();
  await workbench.page.locator('#open-folder').click();
  await workbench.open('example.js');
  assert.equal(await size(workbench.page), '14px');
  assert.equal(await workbench.page.locator('#theme-choice').inputValue(), 'dark');
  await workbench.page.getByRole('button', { name: 'Restricted workspace settings', exact: true }).waitFor();
});

test('G9 routes to existing extension and Intelligence controls with the current session permissions', { timeout: 35_000 }, async t => {
  const { page } = await openWorkbench(t, { 'main.js': 'const example = 2;\n' });
  let center = await openSettings(page);
  await search(center, 'API key');
  const connections = action(center, 'Manage connections');
  await connections.waitFor();
  assert.equal(await connections.isDisabled(), true);
  const blocked = await page.evaluate(() => window.cevra.openIntelligenceSettings('connections').then(() => '', error => error.message));
  assert.match(blocked, /Intelligence is disabled/);
  await search(center, 'plugins');
  await action(center, 'Manage extensions').press('Enter');
  const manager = page.getByRole('dialog', { name: 'Extension Manager', exact: true });
  await manager.waitFor();
  await action(manager, 'Close').press('Enter');
  await manager.waitFor({ state: 'hidden' });

  const opened = page.context().waitForEvent('page');
  await page.getByRole('button', { name: 'Turn on VOKRI Intelligence', exact: true }).press('Enter');
  const pane = await opened;
  await pane.locator('#status').getByText('Ready.', { exact: true }).waitFor();
  const prompt = pane.getByRole('textbox', { name: 'Prompt', exact: true });
  await prompt.fill('Keep this unsent draft.');
  center = await openSettings(page);
  await search(center, 'API key');
  await action(center, 'Manage connections').press('Enter');
  await center.waitFor({ state: 'hidden' });
  await pane.locator('#connections[open]').waitFor();
  await pane.getByRole('button', { name: 'Dock', exact: true }).waitFor();
  assert.equal(await prompt.inputValue(), 'Keep this unsent draft.');
  assert.equal(await pane.evaluate(() => typeof window.cevra), 'undefined');

  await page.locator('#appearance-settings').press('Enter');
  center = settings(page);
  await search(center, 'answer length');
  await action(center, 'Edit response preferences').press('Enter');
  const length = pane.getByLabel('Length', { exact: true });
  await length.selectOption('concise');
  await pane.getByRole('button', { name: 'Save preferences', exact: true }).press('Enter');
  await pane.getByText('Response preferences saved.', { exact: true }).waitFor();
  await pane.getByRole('button', { name: 'Restore defaults', exact: true }).press('Enter');
  assert.equal(await length.inputValue(), 'default');
  await pane.getByRole('button', { name: 'Save preferences', exact: true }).press('Enter');
  await pane.getByText('Response preferences saved.', { exact: true }).waitFor();
});
