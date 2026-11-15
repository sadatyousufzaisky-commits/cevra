const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { openWorkbench, replaceEditor } = require('./desktop-workbench.cjs');

const evidence = process.env.VOKRI_G4_EVIDENCE;
const record = evidence && process.env.VOKRI_G4_RECORD === '1';

async function capture(page, name) {
  if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png'), animations: 'disabled' });
  if (record) await delay(650);
}

async function command(page, title) {
  await page.keyboard.press('Control+Shift+P');
  const query = page.getByRole('combobox', { name: 'Find files, commands or projects' });
  await query.fill(title);
  await page.getByRole('option', { name: new RegExp(title, 'i') }).first().waitFor();
  await query.press('Enter');
}

async function recent(page, name) {
  await command(page, 'Open recent project');
  const query = page.getByRole('combobox', { name: 'Find files, commands or projects' });
  await query.fill(name);
  await page.getByRole('option', { name: new RegExp(name, 'i') }).waitFor();
  await query.press('Enter');
}

test('G4 keyboard journey opens, edits, saves and runs a nested file, then follows a recorded error', { timeout: 60_000 }, async t => {
  const entry = path.join('src (QA)', 'entrée.cjs');
  const fault = path.join('src (QA)', 'math.cjs');
  const workbench = await openWorkbench(t, {
    [entry]: 'const { calculate } = require("./math.cjs");\nconsole.log(calculate(6, 7));\n',
    [fault]: 'function calculate(width, height) {\n  throw new Error("Missing dimensions");\n}\nmodule.exports = { calculate };\n',
    'README.md': '# Demo workspace\n',
  }, undefined, { openOnStart: false, videoPath: record ? path.join(evidence, 'g4-keyboard-journey.webm') : undefined });
  const { page, app, project, editor, state } = workbench;
  await page.waitForFunction(() => !document.getElementById('open-folder').disabled);
  await capture(page, 'g4-01-welcome');
  await page.keyboard.press('Control+o');
  await page.getByRole('heading', { name: 'Choose a file to edit.' }).waitFor();
  const trust = page.getByRole('button', { name: 'Restricted workspace settings' });
  await trust.waitFor();

  await page.keyboard.press('Control+p');
  const picker = page.getByRole('dialog', { name: 'Command center' });
  const query = picker.getByRole('combobox');
  await query.fill('qa ent');
  const result = picker.getByRole('option', { name: /entrée\.cjs/ });
  await result.waitFor();
  assert.match(await picker.ariaSnapshot(), /combobox .*expanded/);
  assert.match(await picker.ariaSnapshot(), /option .*entrée\.cjs.*selected/);
  assert.equal(await query.getAttribute('aria-activedescendant'), await result.getAttribute('id'));
  await capture(page, 'g4-02-file-search');
  await query.press('Enter');
  await workbench.selected('entrée.cjs').waitFor();

  const breadcrumb = page.getByRole('navigation', { name: 'Current file path' });
  const folder = breadcrumb.getByRole('button', { name: 'src (QA)', exact: true });
  await folder.press('Enter');
  const treeFolder = workbench.file('src (QA)');
  await page.waitForFunction(() => document.activeElement?.dataset.folder === 'src (QA)');
  await treeFolder.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'entrée.cjs');

  await editor.press('Control+Home');
  await page.keyboard.insertText('// verified with G4\n');
  await page.locator('#draft-status[data-state="saved"]').waitFor();
  assert.equal(await workbench.file('entrée.cjs').getAttribute('data-dirty'), 'true');
  await command(page, 'Save file');
  await page.locator('#message').getByText(/^Saved/).waitFor();
  assert.match(await fs.readFile(path.join(project, entry), 'utf8'), /^\/\/ verified with G4/);

  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2 }); });
  await editor.press('F5');
  await state.getByText(/^Failed/).waitFor();
  await page.getByRole('button', { name: 'Trusted workspace settings' }).waitFor();
  await capture(page, 'g4-03-runtime-error');
  await command(page, 'Go to run error');
  await workbench.selected('math.cjs').waitFor();
  await page.locator('#cursor').getByText(/^Ln 2,/).waitFor();
  await editor.press('Alt+ArrowLeft');
  await workbench.selected('entrée.cjs').waitFor();
  await editor.press('Alt+ArrowRight');
  await workbench.selected('math.cjs').waitFor();
  await command(page, 'Toggle workspace details');
  await page.getByRole('complementary', { name: 'Workspace details' }).getByText('Execution trusted', { exact: true }).waitFor();
  await capture(page, 'g4-04-iris-ink-dark');
  await page.locator('#theme-choice').selectOption('light');
  await page.waitForFunction(() => document.documentElement.dataset.colorMode === 'light');
  await capture(page, 'g4-05-iris-ink-light');
  await page.getByRole('button', { name: 'Trusted workspace settings' }).press('Enter');
  const settings = page.getByRole('dialog', { name: 'Editor Settings' });
  await settings.getByText('Workspace execution is trusted.', { exact: true }).waitFor();
  await settings.getByRole('button', { name: 'Revoke Trust', exact: true }).press('Enter');
  await settings.getByText('VOKRI Code will ask before running workspace code.', { exact: true }).waitFor();
  await settings.getByRole('button', { name: 'Close', exact: true }).press('Enter');
  await trust.waitFor();
  await page.getByRole('complementary', { name: 'Workspace details' }).getByText('Execution requires permission').waitFor();
});

test('G4 restores split sizes, pinned tools and the floating panel without reducing the editor at compact sizes',
  { timeout: 60_000 }, async t => {
    let workbench = await openWorkbench(t, { 'main.js': 'const answer = 42;\n', 'second.js': 'const other = 7;\n' });
    const { page } = workbench;
    await workbench.open('main.js');
    await workbench.open('second.js');
    await command(page, 'Move active file tab left');
    assert.match(await page.locator('.tab').first().textContent(), /second\.js/);
    await command(page, 'Move active file tab right');
    assert.match(await page.locator('.tab').first().textContent(), /main\.js/);
    await workbench.editor.press('Control+Shift+Tab');
    await workbench.selected('main.js').waitFor();
    await command(page, 'Pin or unpin active file tab');
    assert.equal(await page.locator('.tab').first().getAttribute('data-pinned'), 'true');

    const sidebar = page.locator('#workspace-sidebar');
    const horizontal = page.getByRole('separator', { name: 'Resize Explorer' });
    const previous = (await sidebar.boundingBox()).width;
    await horizontal.press('ArrowRight');
    const bar = await horizontal.boundingBox();
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width / 2 + 24, bar.y + bar.height / 2);
    await page.mouse.up();
    const resized = (await sidebar.boundingBox()).width;
    assert.equal(resized, previous + 40);
    const studio = page.locator('#editor');
    await page.getByRole('button', { name: 'Problems', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Pin current view', exact: true }).press('Enter');
    assert.equal(await page.locator('#show-problems').getAttribute('data-pinned'), 'true');
    const dockedEditor = (await studio.boundingBox()).height;
    await page.getByRole('button', { name: 'Float bottom panel', exact: true }).press('Enter');
    assert.ok((await studio.boundingBox()).height > dockedEditor + 90);
    const vertical = page.getByRole('separator', { name: 'Resize bottom panel' });
    await vertical.press('ArrowUp');
    const dockHeight = (await page.locator('#run-panel').boundingBox()).height;
    await command(page, 'Toggle workspace details');
    await capture(page, 'g4-06-floating-panel');

    workbench = await workbench.restart();
    const reopened = workbench.page;
    await reopened.waitForFunction(() => !document.getElementById('open-folder').disabled);
    await reopened.locator('#open-folder').press('Enter');
    await workbench.file('main.js').waitFor();
    assert.equal((await reopened.locator('#workspace-sidebar').boundingBox()).width, resized);
    assert.equal((await reopened.locator('#run-panel').boundingBox()).height, dockHeight);
    assert.equal(await reopened.locator('#run-panel').getAttribute('data-floating'), 'true');
    assert.equal(await reopened.locator('#show-problems').getAttribute('data-pinned'), 'true');
    await reopened.getByRole('complementary', { name: 'Workspace details' }).waitFor();
    await reopened.getByRole('button', { name: 'Dock bottom panel', exact: true }).press('Enter');
    await workbench.open('main.js');
    await workbench.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(740, 560));
    await reopened.waitForFunction(() => window.innerWidth <= 740);
    await command(reopened, 'Reset workspace layout');
    assert.ok((await reopened.locator('#editor').boundingBox()).height > 340);
    await capture(reopened, 'g4-07-compact');

    await workbench.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
    await reopened.waitForFunction(() => window.innerWidth <= 380);
    assert.equal(await reopened.evaluate(() => document.body.scrollWidth <= window.innerWidth), true);
    await workbench.editor.press('Control+b');
    assert.ok((await reopened.locator('#editor').boundingBox()).width > 300);
    await capture(reopened, 'g4-08-two-hundred-percent');
    await workbench.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await reopened.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await reopened.keyboard.press('Control+Shift+P');
    const results = reopened.getByRole('listbox', { name: 'Command center results' });
    const openFolder = results.getByRole('option', { name: /Open folder/ });
    await openFolder.hover();
    const focusedOption = results.getByRole('option', { selected: true });
    assert.equal(await focusedOption.evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    assert.equal(await openFolder.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    await capture(reopened, 'g4-09-high-contrast');
    await reopened.keyboard.press('Escape');
  });

test('G4 recent projects preserve backed-up drafts and reject a replaced folder without switching', { timeout: 60_000 }, async t => {
  const first = 'first';
  const second = 'reports';
  const scope = { draft: 'unsaved until I come back\n', original: 'original here\n' };
  const workbench = await openWorkbench(t, { [first + '.txt']: scope.original });
  const { app, page, project } = workbench;
  const other = path.join(path.dirname(project), second);
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'other.txt'), 'other source\n');
  await workbench.open(first + '.txt');
  await replaceEditor(workbench, scope.draft);
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, other);
  await workbench.editor.press('Control+o');
  await page.waitForFunction(() => !document.getElementById('open-folder').disabled);
  assert.match(await workbench.editor.textContent(), /unsaved until I come back/);

  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await workbench.editor.press('Control+o');
  await workbench.file('other.txt').waitFor();
  await recent(page, 'project');
  await workbench.selected(first + '.txt').waitFor();
  assert.match(await workbench.editor.textContent(), /unsaved until I come back/);
  assert.equal(await fs.readFile(path.join(project, first + '.txt'), 'utf8'), scope.original);

  await fs.rename(other, other + '-old');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'unrecognized.txt'), 'replacement\n');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2 }); });
  await recent(page, second);
  await page.locator('#message').getByText(/This recent folder changed/).waitFor();
  await workbench.selected(first + '.txt').waitFor();
  assert.match(await workbench.editor.textContent(), /unsaved until I come back/);
  const after = await workbench.restart();
  await after.selected(first + '.txt').waitFor();
  assert.match(await after.editor.textContent(), /unsaved until I come back/);
});
