const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { sha256 } = require('../src/extensions/inspect-package.cjs');
const { createExtensionRegistry } = require('../src/extensions/registry.cjs');
const { archive, manifest } = require('./extension-fixtures.cjs');
const { openWorkbench, replaceEditor } = require('./desktop-workbench.cjs');

async function install(profile, id, contributes, enabled = true) {
  const bytes = archive({ ...manifest(contributes), id });
  const digest = sha256(bytes);
  const file = path.join(path.dirname(profile), `${id} café.zip`);
  await fs.writeFile(file, bytes);
  const registry = createExtensionRegistry(profile);
  await registry.install(file, { reviewedDigest: digest });
  if (enabled) await registry.setEnabled(id, digest, true);
  return [id, digest];
}

function changeRegistry(app, action, args) {
  return app.evaluate(({ app }, { action, args }) => {
    const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
    const { createExtensionRegistry } = require('./src/extensions/registry.cjs');
    return createExtensionRegistry(app.getPath('userData'))[action](...args);
  }, { action, args });
}

function themeSelected(page, value, background) {
  return page.waitForFunction(({ value, background }) => {
    const choice = document.getElementById('theme-choice');
    const editor = document.querySelector('.cm-editor');
    return !choice.disabled && choice.value === value && getComputedStyle(editor).backgroundColor === background;
  }, { value, background });
}

test('extension snippets coexist with semantic completions, identify collisions, and revoke live',
  { timeout: 35_000 }, async t => {
    const entry = 'const duplicateSymbol = 1;\ndup';
    const body = 'const note = "${name}";\r\n// literal café';
    let second;
    const workbench = await openWorkbench(t, { 'entry (#%).js': entry, 'café.py': 'café:' }, async (_project, profile) => {
      second = await install(profile, 'org.cevra.zulu', { snippets: [
        { id: 'literal-body', language: 'javascript', prefix: 'duplicate', body },
        { id: 'py-body', language: 'python', prefix: 'café:', body: 'print("café")' },
      ] }, false);
      await install(profile, 'org.cevra.alpha', { snippets: [
        { id: 'simple-body', language: 'javascript', prefix: 'duplicate', body: 'const alpha = 1;' },
      ] });
    });
    const { app, page, editor, open, project } = workbench;
    const alpha = page.getByRole('option', { name: /duplicate.*org\.cevra\.alpha\/simple-body/ });
    const zulu = page.getByRole('option', { name: /duplicate.*org\.cevra\.zulu\/literal-body/ });
    await open('entry (#%).js');
    await editor.press('Control+End');
    await editor.press('Control+Space');
    await alpha.waitFor();
    await page.getByRole('option', { name: /duplicateSymbol.*const/ }).waitFor();
    assert.equal(await zulu.count(), 0);
    await editor.press('Escape');

    await changeRegistry(app, 'setEnabled', [...second, true]);
    await page.waitForFunction(async () => (await window.cevra.extensionContributions()).packages.length === 2);
    await editor.press('Control+Space');
    await zulu.waitFor();
    await alpha.waitFor();
    await delay(100);
    await zulu.click();
    await page.locator('#draft-status[data-state="saved"]').waitFor();
    assert.deepEqual(await editor.locator('.cm-line').allTextContents(), [
      'const duplicateSymbol = 1;', 'const note = "${name}";', '// literal café',
    ]);
    assert.equal(await fs.readFile(path.join(project, 'entry (#%).js'), 'utf8'), entry);
    await editor.press('Control+z');
    assert.deepEqual(await editor.locator('.cm-line').allTextContents(), entry.split('\n'));

    await open('café.py');
    await editor.press('Control+End');
    await editor.press('Control+Space');
    const python = page.getByRole('option', { name: /café:.*org\.cevra\.zulu\/py-body/ });
    await python.waitFor();
    assert.equal(await alpha.count(), 0);
    await delay(100);
    await python.click();
    assert.deepEqual(await editor.locator('.cm-line').allTextContents(), ['print("café")']);

    await open('entry (#%).js');
    await editor.press('Control+End');
    await editor.press('Control+Space');
    await zulu.waitFor();
    await changeRegistry(app, 'remove', second);
    await zulu.waitFor({ state: 'detached' });
    await editor.press('Control+Space');
    await alpha.waitFor();
    assert.equal(await zulu.count(), 0);
    assert.deepEqual(await editor.locator('.cm-line').allTextContents(), entry.split('\n'));
  });

test('a verified editor palette survives restart, falls back on disable, and is suppressed in safe start',
  { timeout: 45_000 }, async t => {
    const original = 'const value = 1;\n';
    const draft = 'const value = 42;\n';
    let installed;
    let workbench = await openWorkbench(t, { 'entry.js': original }, async (_project, profile) => {
      installed = await install(profile, 'org.cevra.palette', {
        snippets: [{ id: 'ready', language: 'javascript', prefix: 'zzcevra', body: 'const ready = true;' }],
        themes: [{ id: 'deep-sea', label: 'Deep Sea', colors: { background: '#102030', foreground: '#F0F8FF', accent: '#79DCBA' } }],
      });
    });
    const key = `${installed.join(':')}:deep-sea`;
    const theme = workbench.page.getByRole('combobox', { name: 'Theme' });
    const palette = workbench.page.locator('#theme-choice optgroup option');
    const builtIn = 'rgb(252, 253, 251)';
    const extension = 'rgb(16, 32, 48)';
    await workbench.open('entry.js');
    await palette.waitFor({ state: 'attached' });
    await theme.selectOption('light');
    await themeSelected(workbench.page, 'light', builtIn);
    await replaceEditor(workbench, draft);
    await theme.selectOption(key);
    await themeSelected(workbench.page, key, extension);
    assert.equal(await workbench.editor.getByText('const', { exact: true }).evaluate(node => getComputedStyle(node).color),
      'rgb(121, 220, 186)');
    assert.equal(await workbench.page.locator('.titlebar').evaluate(node => getComputedStyle(node).backgroundColor),
      'rgb(239, 244, 239)');

    workbench = await workbench.restart();
    await workbench.selected('entry.js').waitFor();
    await themeSelected(workbench.page, key, extension);
    await changeRegistry(workbench.app, 'setEnabled', [...installed, false]);
    await themeSelected(workbench.page, 'light', builtIn);
    assert.equal(await workbench.page.locator('#theme-choice optgroup').count(), 0);
    const rejected = await workbench.page.evaluate(value => window.cevra.setExtensionPalette(value)
      .then(() => '', error => error.message), key);
    assert.match(rejected, /extension palette is unavailable/);
    await changeRegistry(workbench.app, 'setEnabled', [...installed, true]);
    await themeSelected(workbench.page, key, extension);

    workbench = await workbench.restart({ args: ['--disable-extensions'] });
    await workbench.selected('entry.js').waitFor();
    await themeSelected(workbench.page, 'light', builtIn);
    assert.equal(await workbench.page.locator('#theme-choice optgroup').count(), 0);
    assert.deepEqual(await workbench.page.evaluate(() => window.cevra.extensionContributions()), { packages: [], palette: null });
    assert.equal((await changeRegistry(workbench.app, 'list', []))[0].enabled, true);
    assert.deepEqual(await workbench.editor.locator('.cm-line').allTextContents(), draft.split('\n'));
    assert.equal(await fs.readFile(path.join(workbench.project, 'entry.js'), 'utf8'), original);

    workbench = await workbench.restart();
    await workbench.selected('entry.js').waitFor();
    await themeSelected(workbench.page, key, extension);
    await changeRegistry(workbench.app, 'remove', installed);
    await themeSelected(workbench.page, 'light', builtIn);
    assert.equal(await workbench.page.locator('#theme-choice optgroup').count(), 0);
  });

test('a damaged registry leaves the editor usable and contributes no palette or snippet',
  { timeout: 25_000 }, async t => {
    const damaged = 'damaged snapshot';
    const workbench = await openWorkbench(t, { 'note.txt': 'before\n' }, async (_project, profile) => {
      const folder = path.join(profile, 'extensions');
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, 'registry.json'), damaged);
    });
    await workbench.open('note.txt');
    await themeSelected(workbench.page, 'dark', 'rgb(16, 20, 23)');
    assert.equal(await workbench.page.locator('#theme-choice optgroup').count(), 0);
    await replaceEditor(workbench, 'after\n');
    await workbench.editor.press('Control+s');
    await workbench.page.locator('#message').getByText('Saved note.txt', { exact: true }).waitFor();
    assert.equal(await fs.readFile(path.join(workbench.project, 'note.txt'), 'utf8'), 'after\n');
    assert.equal(await fs.readFile(path.join(workbench.profile, 'extensions', 'registry.json'), 'utf8'), damaged);
  });
