const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { openWorkbench, replaceEditor } = require('./desktop-workbench.cjs');
const { types } = require('../src/windows-file-types.json');

const windows = process.platform === 'win32';
const repo = path.resolve(__dirname, '..');
const execute = promisify(execFile);
const text = '\ufeffOriginal α\r\n';
const edited = 'Edited β\n';

function send(workbench, entries, cwd = workbench.project) {
  return execute(require('electron'), [repo, '--user-data-dir=' + workbench.profile, '--vokri-open', '--', ...entries],
    { cwd, windowsHide: true, timeout: 15_000 });
}

test('G10 opens and saves every registered type from one Windows launch', { skip: !windows, timeout: 55_000 }, async t => {
  const names = Object.values(types).flat().map((extension, index) => `étude ${index} (QA) & 50%${extension}`);
  const workbench = await openWorkbench(t, Object.fromEntries(names.map(name => [name, text])), undefined, {
    openOnStart: false, args: project => ['--vokri-open', '--', ...names.map(name => path.join(project, name)),
      path.join(project, 'unavailable.js')],
  });
  const { page, editor, project } = workbench;
  await workbench.selected(names.at(-1)).waitFor();
  assert.equal(await page.locator('#tabs [data-tab-id]').count(), names.length);
  await page.locator('#message[data-error="true"]').getByText('Some Explorer items are unavailable or unsupported.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Restricted workspace settings', exact: true }).waitFor();
  for (const name of names) {
    const file = path.join(project, name);
    assert.deepEqual(await fs.readFile(file), Buffer.from(text));
    await workbench.open(name);
    await replaceEditor(workbench, edited);
    await editor.press('Control+s');
    await page.locator('#message').getByText('Saved ' + name, { exact: true }).waitFor();
    assert.deepEqual(await fs.readFile(file), Buffer.from('\ufeffEdited β\r\n'));
  }
});

test('G10 reuses a running Windows workbench and preserves drafts and queued folder selections', { skip: !windows, timeout: 45_000 }, async t => {
  let first;
  let second;
  const workbench = await openWorkbench(t, { 'entry.js': 'const entry = 1;\n', 'nested/東京 & report.ts': 'export const fresh = 1;\n' },
    async (project, profile) => {
      first = path.join(path.dirname(profile), 'folder α');
      second = path.join(path.dirname(profile), 'folder β');
      await fs.mkdir(first);
      await fs.mkdir(second);
      await fs.writeFile(path.join(first, 'alpha.txt'), 'First');
      await fs.writeFile(path.join(second, 'beta.txt'), 'Second');
    });
  const { app, page, project, editor } = workbench;
  await workbench.open('entry.js');
  await replaceEditor(workbench, 'const draft = true;\n');
  const nested = path.join(project, 'nested');
  await send(workbench, ['東京 & report.ts'], nested);
  await workbench.selected('東京 & report.ts').waitFor();
  assert.match(await editor.textContent(), /export const fresh/);
  await workbench.open('entry.js');
  assert.match(await editor.textContent(), /const draft/);
  assert.equal(await fs.readFile(path.join(project, 'entry.js'), 'utf8'), 'const entry = 1;\n');

  await app.evaluate(({ dialog }) => {
    globalThis.explorerPrompts = [];
    dialog.showMessageBox = async (_window, details) => {
      globalThis.explorerPrompts.push(details.title);
      return { response: 0 };
    };
  });
  await send(workbench, [first, second]);
  const pending = page.getByRole('button', { name: 'Open next Explorer selection (1)', exact: true });
  await pending.waitFor();
  await page.waitForFunction(() => !document.getElementById('explorer-open-next').disabled);
  assert.equal(await workbench.selected('entry.js').count(), 1);
  assert.match(await editor.textContent(), /const draft/);
  assert.equal((await app.evaluate(() => globalThis.explorerPrompts)).length, 1);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await pending.press('Enter');
  await workbench.file('beta.txt').waitFor();
  await pending.waitFor({ state: 'hidden' });
  await send(workbench, [project]);
  await workbench.selected('entry.js').waitFor();
  assert.match(await editor.textContent(), /const draft/);
  assert.equal(await fs.readFile(path.join(project, 'entry.js'), 'utf8'), 'const entry = 1;\n');
  assert.equal(app.windows().length, 1);
});

test('G10 opens a long local path while rejecting unsupported selections without running code', { skip: !windows, timeout: 35_000 }, async t => {
  let long;
  let link;
  let hardlink;
  const workbench = await openWorkbench(t, { 'entry.js': 'throw new Error("should never execute");\n' },
    async project => {
      const directory = path.join(project, 'a'.repeat(118), 'b'.repeat(118));
      await fs.mkdir(directory, { recursive: true });
      long = path.join(directory, 'long 寿命 (QA).js');
      await fs.writeFile(long, 'const long = true;\n');
      link = path.join(project, 'alias');
      await fs.symlink(directory, link, 'junction');
      hardlink = path.join(project, 'hardlink.js');
      await fs.link(long, hardlink);
      // A genuine long file beside the linked file exercises the normal read path.
      long = path.join(directory, 'open 長 (QA).js');
      await fs.writeFile(long, 'const exact = true;\n');
      await fs.writeFile(path.join(project, 'binary.js'), Buffer.from([0xff, 0xfe, 0xff]));
    });
  await send(workbench, [
    path.toNamespacedPath(long),
    path.join(link, path.basename(long)), hardlink, path.join(workbench.project, 'binary.js'),
    path.join(workbench.project, 'entry.js') + ':stream', '\\\\driver\\pipe\\never-connect.js', '--inspect=0',
  ]);
  await workbench.selected(path.basename(long)).waitFor();
  assert.match(await workbench.editor.textContent(), /const exact = true/);
  assert.equal(await workbench.page.locator('#tabs [data-tab-id]').count(), 1);
  assert.equal(await workbench.output.getByText('should never execute').count(), 0);
  await workbench.page.getByRole('button', { name: 'Restricted workspace settings', exact: true }).waitFor();
});

test('G10 opens the Windows Default apps surface from the control center', { skip: !windows, timeout: 25_000 }, async t => {
  const { app, page } = await openWorkbench(t, {}, undefined, { openOnStart: false });
  await app.evaluate(({ shell }) => {
    globalThis.defaultAppsCalls = [];
    shell.openExternal = async uri => { globalThis.defaultAppsCalls.push(uri); };
  });
  await page.locator('#editor-settings:enabled').waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).press('Enter');
  const center = page.getByRole('dialog', { name: 'Settings', exact: true });
  await center.getByRole('searchbox', { name: 'Search settings' }).fill('default editor');
  await center.getByRole('button', { name: 'Open Default apps', exact: true }).click();
  await center.locator('#windows-default-apps:enabled').waitFor();
  const calls = await app.evaluate(() => ({
    urls: globalThis.defaultAppsCalls, build: Number(process.getSystemVersion().split('.')[2]),
  }));
  assert.deepEqual(calls.urls, [calls.build >= 22000 ? 'ms-settings:defaultapps?registeredAppUser=VOKRI%20Code' : 'ms-settings:defaultapps']);
});
