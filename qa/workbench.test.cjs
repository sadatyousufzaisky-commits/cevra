const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { _electron } = require('playwright');

const repo = path.resolve(__dirname, '..');
const execute = promisify(execFile);

async function assertWindowsProcessStopped(pid) {
  if (process.platform !== 'win32') return;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await delay(25);
  }
  assert.fail('The Windows process was still running after cleanup.');
}

async function openWorkbench(t, files) {
  const temp = await fs.realpath(os.tmpdir());
  const sandbox = await fs.mkdtemp(path.join(temp, 'cevra-workbench-'));
  const project = path.join(sandbox, 'project (QA) & café [#%]');
  const profile = path.join(sandbox, 'profile');
  let app;
  t.after(async () => {
    try {
      await app?.close();
    } finally {
      const resolved = await fs.realpath(sandbox);
      assert.equal(resolved, sandbox);
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  await fs.mkdir(project);
  await fs.mkdir(profile);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(project, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  async function launch() {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [repo, '--user-data-dir=' + profile],
      cwd: repo,
      env,
      chromiumSandbox: true,
      timeout: 20_000,
    });
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      dialog.showMessageBox = async () => ({ response: 1 });
      dialog.showMessageBoxSync = () => 1;
    }, project);
    const page = await app.firstWindow();
    page.setDefaultTimeout(8_000);
    const explorer = page.getByRole('navigation', { name: 'Project files' });
    const file = name => explorer.getByRole('button', { name, exact: true });
    const selected = name => page.locator('#tabs [aria-current="true"]').getByText(name, { exact: true });
    return {
      app,
      project,
      profile,
      page,
      editor: page.getByRole('textbox', { name: 'Source editor' }),
      file,
      selected,
      open: async name => {
        await file(name).click();
        await selected(name).waitFor();
      },
      state: page.locator('#run-state'),
      output: page.locator('#run-output'),
      restart: async ({ crash = false } = {}) => {
        if (crash) {
          const processUnderTest = app.process();
          const exited = once(processUnderTest, 'exit');
          if (process.platform === 'win32') {
            const taskkill = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe');
            await execute(taskkill, ['/pid', String(processUnderTest.pid), '/t', '/f'], { windowsHide: true });
          } else {
            assert.ok(processUnderTest.kill('SIGKILL'));
          }
          await exited;
        } else {
          const closed = app.waitForEvent('close', { timeout: 10_000 });
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
          await closed;
        }
        app = undefined;
        return launch();
      },
    };
  }
  const result = await launch();
  await result.page.locator('#open-folder').click();
  await result.page.getByRole('heading', { name: 'Choose a file to edit.' }).waitFor();
  return result;
}

test('saves a nested UTF-8 file with BOM and CRLF and preserves external changes', async t => {
  const folder = 'notes (draft)';
  const name = 'café [#%].txt';
  const relative = path.join(folder, name);
  const { project, page, file, open, editor } = await openWorkbench(t, {
    [relative]: '\uFEFFone\r\ntwo\r\n',
  });
  await file(folder).click();
  await open(name);
  await editor.press('Control+Home');
  await page.keyboard.insertText('saved ');
  await editor.press('Control+s');
  await page.locator('#message').getByText('Saved ' + relative, { exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project, relative), 'utf8'), '\uFEFFsaved one\r\ntwo\r\n');

  await page.keyboard.insertText('pending ');
  await fs.writeFile(path.join(project, relative), 'external change\n');
  await editor.press('Control+s');
  await page.locator('#message').getByText(/This file changed on disk/).waitFor();
  await page.getByRole('button', { name: 'Save recovery copy', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project, relative), 'utf8'), 'external change\n');
  assert.match(await editor.textContent(), /saved pending one/);
});

test('saves before execution, runs from the project root, and stops a running script', async t => {
  const name = 'run (edited) & ready.cjs';
  const changed = 'console.log("saved before execution");\nconsole.log(process.cwd());\n';
  const { project, page, open, editor, state, output } = await openWorkbench(t, {
    [name]: 'console.log("old contents");\n',
    'long.cjs': [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
      'child.on("spawn", () => console.log("ready to stop " + child.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  });
  await open(name);
  await editor.press('Control+a');
  await page.keyboard.insertText(changed);
  await editor.press('F5');
  await state.getByText(/^Passed/).waitFor();
  const result = await output.textContent();
  assert.match(result, /saved before execution/);
  assert.ok(result.includes(project));
  assert.equal(await fs.readFile(path.join(project, name), 'utf8'), changed);

  await open('long.cjs');
  await editor.press('F5');
  await output.getByText(/ready to stop \d+/).waitFor();
  const child = Number(/ready to stop (\d+)/.exec(await output.textContent())[1]);
  await page.getByRole('button', { name: 'Stop run', exact: true }).click();
  await state.getByText('Stopped', { exact: true }).waitFor();
  await assertWindowsProcessStopped(child);
});

test('jumps to runtime and syntax errors in nested files at unusual paths', async t => {
  const folder = 'nested (source) & café [#%]';
  const cjs = 'crash (detail) # %.cjs';
  const mjs = 'crash (module) # %.mjs';
  const syntax = 'syntax (detail) # %.mjs';
  const cjsImport = './' + folder + '/' + cjs;
  const mjsImport = './' + [folder, mjs].map(encodeURIComponent).join('/');
  const { page, file, open, selected, editor, state, output } = await openWorkbench(t, {
    'entry.cjs': 'require(' + JSON.stringify(cjsImport) + ')();\n',
    'entry.mjs': 'import ' + JSON.stringify(mjsImport) + ';\n',
    [path.join(folder, cjs)]: 'function explode() {\n  const message = "nested CJS failure";\n  throw new Error(message);\n}\nmodule.exports = explode;\n',
    [path.join(folder, mjs)]: 'function explode() {\n  const message = "nested ESM failure";\n  throw new Error(message);\n}\nexplode();\n',
    [path.join(folder, syntax)]: '// Deliberate parse error.\nconst broken = ;\n',
  });
  for (const [entry, target, error] of [
    ['entry.cjs', cjs, /nested CJS failure/],
    ['entry.mjs', mjs, /nested ESM failure/],
  ]) {
    await open(entry);
    await editor.press('F5');
    await state.getByText(/^Failed/).waitFor();
    const source = page.locator('#jump-to-error');
    assert.equal(await source.locator('span').textContent(), path.join(folder, target) + ':3:9',
      await output.textContent());
    await source.click();
    await selected(target).waitFor();
    await page.locator('#cursor').getByText('Ln 3, Col 9', { exact: true }).waitFor();
    assert.match(await editor.textContent(), error);
    assert.match(await output.textContent(), error);
  }

  await file(folder).click();
  await open(syntax);
  await editor.press('F5');
  await page.getByRole('button', { name: path.join(folder, syntax) + ':2:16' }).click();
  await page.locator('#cursor').getByText('Ln 2, Col 16', { exact: true }).waitFor();
  assert.match(await output.textContent(), /SyntaxError/);
});

test('jumps to a test assertion and retries only the failed case after saving a fix', async t => {
  const input = [
    "const { describe, it } = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const calculate = require('./calculate.cjs');",
    "describe('weights', () => {",
    "  it('same name', () => { console.log('first case executed'); assert.equal(calculate(2), 2); });",
    "  it('same name', () => {",
    "    assert.equal(calculate(1.25), 1.25);",
    "  });",
    "});",
  ].join('\n') + '\n';
  const fix = 'module.exports = value => value;\n';
  const { project, page, open, selected, editor, output } = await openWorkbench(t, {
    'calculate.cjs': 'module.exports = value => Math.floor(value);\n',
    'weights.test.cjs': input,
  });
  const totals = page.locator('#test-totals');
  const runTests = page.getByRole('button', { name: 'Run tests', exact: true });
  const retry = page.getByRole('button', { name: 'Rerun failures', exact: true });
  await runTests.click();
  await totals.getByText('1 passed · 1 failed', { exact: true }).waitFor();
  await page.getByRole('button', { name: /same name.*weights\.test\.cjs:7:12/ }).click();
  await selected('weights.test.cjs').waitFor();
  await page.locator('#cursor').getByText('Ln 7, Col 12', { exact: true }).waitFor();
  assert.match(await output.textContent(), /first case executed/);

  await open('calculate.cjs');
  await editor.press('Control+a');
  await page.keyboard.insertText(fix);
  await retry.click();
  await totals.getByText('1 passed · 0 failed · 1 already passed', { exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project, 'calculate.cjs'), 'utf8'), fix);
  assert.doesNotMatch(await output.textContent(), /first case executed/);
  assert.equal(await retry.isVisible(), false);
});

async function replaceEditor(workbench, text) {
  await workbench.editor.press('Control+a');
  await workbench.page.keyboard.insertText(text);
  await workbench.page.locator('#draft-status[data-state="saved"]').waitFor();
}

test('keeps drafts across a regular quit and clears them on confirmed discard', { timeout: 35_000 }, async t => {
  let workbench = await openWorkbench(t, { 'note.txt': 'original\n' });
  await workbench.open('note.txt');
  await replaceEditor(workbench, 'keep this across quit\n');
  workbench = await workbench.restart();
  await workbench.selected('note.txt').waitFor();
  assert.match(await workbench.editor.textContent(), /keep this across quit/);
  assert.equal(await fs.readFile(path.join(workbench.project, 'note.txt'), 'utf8'), 'original\n');
  await workbench.page.getByRole('button', { name: 'Close note.txt', exact: true }).click();
  await workbench.page.getByRole('heading', { name: 'Choose a file to edit.' }).waitFor();
  assert.deepEqual((await fs.readdir(path.join(workbench.profile, 'drafts'))).filter(name => name.endsWith('.json')), []);
  workbench = await workbench.restart();
  await workbench.page.getByRole('heading', { name: 'Your project starts here.' }).waitFor();
});

test('reloads a crashed renderer and saves the recovered draft normally', { timeout: 35_000 }, async t => {
  const workbench = await openWorkbench(t, {
    'renderer.cjs': 'console.log("original");\n',
    'running.cjs': 'console.log("running " + process.pid);\nsetInterval(() => {}, 1000);\n',
  });
  await workbench.open('renderer.cjs');
  await replaceEditor(workbench, 'console.log("renderer recovery");\n');
  await workbench.open('running.cjs');
  await workbench.editor.press('F5');
  await workbench.output.getByText(/running \d+/).waitFor();
  const running = Number(/running (\d+)/.exec(await workbench.output.textContent())[1]);
  const replacement = workbench.app.waitForEvent('window', { timeout: 10_000 });
  await workbench.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  const page = await replacement;
  await assertWindowsProcessStopped(running);
  page.setDefaultTimeout(8_000);
  const editor = page.getByRole('textbox', { name: 'Source editor' });
  await page.getByText('Recovered 1 unsaved file.', { exact: true }).waitFor();
  assert.match(await editor.textContent(), /renderer recovery/);
  await editor.press('Control+s');
  await page.getByText('Saved renderer.cjs', { exact: true }).waitFor();
  await page.locator('#draft-status[data-state="clear"]').waitFor({ state: 'attached' });
  assert.equal(await fs.readFile(path.join(workbench.project, 'renderer.cjs'), 'utf8'), 'console.log("renderer recovery");\n');
});

test('recovers multiple drafts after a forced app crash and protects changed or deleted originals', { timeout: 35_000 }, async t => {
  let workbench = await openWorkbench(t, {
    'normal.txt': 'normal original\n',
    'changed.txt': 'changed original\n',
    'deleted.txt': 'deleted original\n',
  });
  for (const name of ['normal', 'changed', 'deleted']) {
    await workbench.open(name + '.txt');
    await replaceEditor(workbench, name + ' draft\n');
  }
  const { project } = workbench;
  await fs.writeFile(path.join(project, 'changed.txt'), 'external edit\n');
  await fs.unlink(path.join(project, 'deleted.txt'));
  workbench = await workbench.restart({ crash: true });
  await workbench.page.getByText(/Recovered 3 unsaved files/).waitFor();

  const tabs = workbench.page.locator('#tabs');
  await tabs.getByRole('button', { name: 'normal.txt, unsaved', exact: true }).click();
  assert.match(await workbench.editor.textContent(), /normal draft/);
  await workbench.editor.press('Control+s');
  await workbench.page.getByText('Saved normal.txt', { exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project, 'normal.txt'), 'utf8'), 'normal draft\n');

  for (const name of ['changed', 'deleted']) {
    await tabs.getByRole('button', { name: name + '.txt, unsaved', exact: true }).click();
    assert.match(await workbench.editor.textContent(), new RegExp(name + ' draft'));
    await workbench.editor.press('Control+s');
    await workbench.page.getByText(/The original changed or is unavailable/).waitFor();
    await workbench.page.getByRole('button', { name: 'Save recovery copy', exact: true }).click();
    await workbench.page.getByText(/Saved recovery copy/).waitFor();
    const recovered = (await fs.readdir(project)).find(file => file.startsWith(name + ' (recovered '));
    assert.ok(recovered);
    assert.equal(await fs.readFile(path.join(project, recovered), 'utf8'), name + ' draft\n');
  }
  assert.equal(await fs.readFile(path.join(project, 'changed.txt'), 'utf8'), 'external edit\n');
  await assert.rejects(fs.stat(path.join(project, 'deleted.txt')), { code: 'ENOENT' });
});

test('the desktop bridge blocks workspace escapes and rejects a Windows junction', async t => {
  const { project, page } = await openWorkbench(t, { 'inside.cjs': 'console.log("inside");\n' });
  const outside = path.join(path.dirname(project), 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.cjs'), 'outside contents');
  await fs.symlink(outside, path.join(project, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  const errors = await page.evaluate(async () => {
    const { project } = await window.cevra.initial();
    const { revision } = await window.cevra.read(project.id, 'inside.cjs');
    const operations = [
      window.cevra.read(project.id, '../outside/secret.cjs'),
      window.cevra.save(project.id, 'junction/secret.cjs', 'changed', revision),
      window.cevra.start(project.id, 'junction/secret.cjs', revision, 1),
      window.cevra.read('expired-workspace', 'inside.cjs'),
    ];
    return (await Promise.allSettled(operations)).map(result => result.reason?.message);
  });
  assert.match(errors[0], /outside the workspace/);
  assert.match(errors[1], /links cannot be opened/);
  assert.match(errors[2], /links cannot be opened/);
  assert.match(errors[3], /workspace has closed/);
  assert.equal(await fs.readFile(path.join(outside, 'secret.cjs'), 'utf8'), 'outside contents');
});

test('project search follows unsaved versions and Back and Forward restore editor positions', async t => {
  const folder = 'nested (# % &)';
  const target = 'draft.cjs';
  const relative = path.join(folder, target);
  const workbench = await openWorkbench(t, {
    'origin.cjs': '// origin\nconst original = 1;\n',
    [relative]: '// on disk\nconst item = "disk-only";\n',
  });
  const { page, editor, file, open, project, selected } = workbench;
  await file(folder).click();
  await open(target);
  await replaceEditor(workbench, '// in memory\nconst item = "draft-only";\n');
  await open('origin.cjs');
  await editor.press('Control+Home');
  await editor.press('ArrowDown');
  await editor.press('ArrowRight');
  await editor.press('ArrowRight');
  const cursor = page.locator('#cursor');
  await cursor.getByText('Ln 2, Col 3', { exact: true }).waitFor();

  await editor.press('Control+Shift+f');
  const query = page.getByRole('searchbox', { name: 'Search project' });
  const results = page.getByRole('list', { name: 'Search matches' });
  await query.fill('disk-only');
  await page.locator('#search-status').getByText('No matches', { exact: true }).waitFor();
  await query.fill('draft-only');
  await results.getByRole('button', { name: relative + ':2:15 const item = "draft-only";' }).click();
  await selected(target).waitFor();
  await cursor.getByText('Ln 2, Col 15', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'draft-only');
  assert.match(await fs.readFile(path.join(project, relative), 'utf8'), /disk-only/);

  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await selected('origin.cjs').waitFor();
  await cursor.getByText('Ln 2, Col 3', { exact: true }).waitFor();
  await editor.press('Alt+ArrowRight');
  await selected(target).waitFor();
  await cursor.getByText('Ln 2, Col 15', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'draft-only');

  await page.keyboard.insertText('fresh-only');
  await page.locator('#search-status').getByText('No matches', { exact: true }).waitFor();
  await query.fill('fresh-only');
  await results.getByRole('button', { name: /fresh-only/ }).waitFor();
  await editor.press('Control+z');
  await page.locator('#search-status').getByText('No matches', { exact: true }).waitFor();
  assert.match(await editor.textContent(), /draft-only/);
  await page.getByRole('button', { name: 'Search project', exact: true }).click();
  await open('origin.cjs');
  await cursor.getByText('Ln 2, Col 3', { exact: true }).waitFor();
});

test('project search rejects stale disk matches and allows cancellation from the sidebar', async t => {
  const { page, open, project, selected } = await openWorkbench(t, {
    'active.cjs': '// keep this editor active\n',
    'result.cjs': 'console.log("search original");\n',
  });
  await open('active.cjs');
  await page.getByRole('button', { name: 'Search project', exact: true }).click();
  const query = page.getByRole('searchbox', { name: 'Search project' });
  const status = page.locator('#search-status');
  const results = page.getByRole('list', { name: 'Search matches' });
  await query.fill('search original');
  const hit = results.getByRole('button', { name: /result\.cjs:1:14/ });
  await hit.waitFor();
  await fs.writeFile(path.join(project, 'result.cjs'), '// moved\nconsole.log("replacement");\n');
  await hit.click();
  await status.getByText('This match is out of date. Search again.', { exact: true }).waitFor();
  await selected('active.cjs').waitFor();

  await query.evaluate(input => {
    input.value = 'replacement';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('search-cancel').click();
  });
  await status.getByText('Search canceled.', { exact: true }).waitFor();
  assert.equal(await results.getByRole('button').count(), 0);
  await query.press('Enter');
  await results.getByRole('button', { name: /result\.cjs:2:14/ }).click();
  await selected('result.cjs').waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'replacement');
});

test('in-file search supports case and whole-word replacement with one undo', async t => {
  const { page, editor, open } = await openWorkbench(t, { 'notes.txt': 'alpha alphabet ALPHA\nalpha\n' });
  await open('notes.txt');
  await editor.press('Control+f');
  const panel = page.locator('.cm-search');
  const find = panel.getByRole('textbox', { name: 'Find', exact: true });
  await find.fill('alpha');
  await find.press('End');
  await panel.getByRole('checkbox', { name: 'match case' }).check();
  await panel.getByRole('checkbox', { name: 'by word' }).check();
  const replacement = panel.getByRole('textbox', { name: 'Replace', exact: true });
  await replacement.fill('beta');
  await replacement.press('End');
  await panel.getByRole('button', { name: 'replace all', exact: true }).click();
  assert.deepEqual((await editor.locator('.cm-line').allTextContents()).slice(0, 2), ['beta alphabet ALPHA', 'beta']);
  await editor.press('Control+z');
  assert.deepEqual((await editor.locator('.cm-line').allTextContents()).slice(0, 2), ['alpha alphabet ALPHA', 'alpha']);
});

test('live Problems use unsaved source and navigate to the exact range before any run', async t => {
  const folder = 'nested (# % &)';
  const name = 'check.cjs';
  const file = path.join(folder, name);
  const original = '// saved text\nconst sample = 1;\n';
  const workbench = await openWorkbench(t, {
    'origin.cjs': 'const origin = true;\n',
    [file]: original,
  });
  const { page, editor, open, project, selected, state } = workbench;
  await workbench.file(folder).click();
  await open(name);
  await editor.press('Control+Shift+m');
  const status = page.locator('#problems-status');
  const problems = page.getByRole('region', { name: 'Syntax problems' });
  await status.getByText('No syntax problems.', { exact: true }).waitFor();

  await replaceEditor(workbench, '// unsaved text\nconst sample = ;\n');
  const issue = problems.getByRole('button', { name: 'Error Expression expected. Ln 2, Col 16' });
  await issue.waitFor();
  await problems.getByRole('heading', { name: file, exact: true }).waitFor();
  await editor.locator('.cm-lintRange-error').waitFor();
  await page.locator('.cm-lint-marker-error').waitFor();
  assert.equal(await state.textContent(), 'Ready');
  assert.equal(await fs.readFile(path.join(project, file), 'utf8'), original);

  await open('origin.cjs');
  await issue.click();
  await selected(name).waitFor();
  await page.locator('#cursor').getByText('Ln 2, Col 16', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), ';');
  await page.keyboard.insertText('42;');
  await issue.waitFor({ state: 'detached' });
  await editor.locator('.cm-lintRange-error').waitFor({ state: 'detached' });
  await status.getByText('No syntax problems.', { exact: true }).waitFor();
  assert.match(await editor.textContent(), /sample = 42;/);
  assert.equal(await fs.readFile(path.join(project, file), 'utf8'), original);
});

test('Problems checks TypeScript tabs and clears closed documents', async t => {
  const typed = 'const value = 1;\u2028const count: number = ;\n';
  const column = typed.lastIndexOf(';') + 1;
  const { page, open, editor, selected } = await openWorkbench(t, {
    'typed.ts': typed,
    'notes.txt': 'const ignored = ;\n',
  });
  await open('typed.ts');
  await page.locator('#language').getByText('TypeScript', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Problems', exact: true }).click();
  const problems = page.getByRole('region', { name: 'Syntax problems' });
  const issue = problems.getByRole('button', { name: 'Error Expression expected. Ln 1, Col ' + column });
  await issue.waitFor();
  await open('notes.txt');
  assert.equal(await page.locator('#language').textContent(), 'Plain text');
  await issue.click();
  await selected('typed.ts').waitFor();
  await page.locator('#cursor').getByText('Ln 1, Col ' + column, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), ';');
  await editor.press('Control+w');
  await selected('notes.txt').waitFor();
  await page.locator('#problems-status').getByText('Open a JavaScript or TypeScript file to check syntax.').waitFor();
  assert.equal(await problems.getByRole('button').count(), 0);
});

test('late syntax replies stay hidden and unavailable checks can be retried', { timeout: 25_000 }, async t => {
  const workbench = await openWorkbench(t, { 'check.js': 'const n = 1;\n' });
  const { app, page, open, editor } = workbench;
  await app.evaluate(({ ipcMain }) => {
    let unavailableOnce = true;
    ipcMain.removeHandler('cevra:syntax');
    ipcMain.handle('cevra:syntax', (_event, _id, _file, text) => {
      if (text.includes('hold check')) {
        return new Promise(resolve => {
          ipcMain.releaseHeldSyntax = () => resolve({
            issues: [{ from: 0, to: 5, line: 1, column: 1, severity: 'error', code: 1, message: 'Stale diagnostic' }],
            omitted: 0,
          });
          ipcMain.waitForHeldSyntax?.();
        });
      }
      if (text.includes('fail check') && unavailableOnce) {
        unavailableOnce = false;
        throw new Error('Test analyzer unavailable.');
      }
      return { issues: [], omitted: 0 };
    });
  });
  await open('check.js');
  await page.getByRole('button', { name: 'Problems', exact: true }).click();
  const status = page.locator('#problems-status');
  await status.getByText('No syntax problems.', { exact: true }).waitFor();
  await replaceEditor(workbench, '// hold check\nconst n = ;\n');
  await app.evaluate(({ ipcMain }) => {
    if (ipcMain.releaseHeldSyntax) return;
    return new Promise(resolve => { ipcMain.waitForHeldSyntax = resolve; });
  });
  await page.evaluate(() => {
    const list = document.getElementById('problem-list');
    window.sawStaleDiagnostic = false;
    new MutationObserver(() => {
      if (list.textContent.includes('Stale diagnostic')) window.sawStaleDiagnostic = true;
    }).observe(list, { childList: true, subtree: true });
  });
  await replaceEditor(workbench, '// latest buffer\nconst n = 2;\n');
  await app.evaluate(({ ipcMain }) => ipcMain.releaseHeldSyntax());
  await status.getByText('No syntax problems.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.sawStaleDiagnostic), false);
  assert.equal(await editor.locator('.cm-lintRange-error').count(), 0);

  await replaceEditor(workbench, '// fail check\nconst n = 3;\n');
  await status.getByText('1 unavailable', { exact: true }).waitFor();
  await page.getByText('Test analyzer unavailable.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry checks', exact: true }).click();
  await status.getByText('No syntax problems.', { exact: true }).waitFor();
  assert.match(await editor.textContent(), /const n = 3;/);
});

test('Format Document uses the unsaved buffer, keeps selection, and forms one undo step', async t => {
  const name = 'format (# %).cjs';
  const source = 'const total=(a,b)=>{return a+b};\n';
  const original = '\uFEFFconst initial = 0;\n';
  const workbench = await openWorkbench(t, {
    [name]: original,
    'ending.cjs': 'const value = 1;\n',
    '.cevra-format.json': '{"indentWidth":4,"lineEnding":"crlf"}',
  });
  const { page, editor, project, open } = workbench;
  const ending = page.locator('#line-ending');
  await open(name);
  await replaceEditor(workbench, source);
  await editor.press('Control+Home');
  for (let i = 0; i < source.indexOf('return'); i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 'return'.length; i++) await page.keyboard.press('Shift+ArrowRight');
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'return');

  await editor.press('Shift+Alt+f');
  await page.locator('#message').getByText('Formatted ' + name, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'return');
  const lines = ['const total = (a, b) => {', '    return a + b', '};'];
  assert.deepEqual((await editor.locator('.cm-line').allTextContents()).slice(0, 3), lines);
  assert.equal(await ending.textContent(), 'CRLF');
  assert.equal(await fs.readFile(path.join(project, name), 'utf8'), original);
  await page.locator('#draft-status[data-state="saved"]').waitFor();

  await editor.press('Control+z');
  assert.equal((await editor.locator('.cm-line').allTextContents())[0], source.trimEnd());
  assert.equal(await ending.textContent(), 'LF');
  await editor.press('Control+y');
  assert.deepEqual((await editor.locator('.cm-line').allTextContents()).slice(0, 3), lines);
  assert.equal(await ending.textContent(), 'CRLF');
  await editor.press('Control+s');
  await page.locator('#message').getByText('Saved ' + name, { exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project, name), 'utf8'), '\uFEFF' + lines.join('\r\n') + '\r\n');

  await open('ending.cjs');
  await page.getByRole('button', { name: 'Format document', exact: true }).click();
  await page.locator('#message').getByText('Formatted ending.cjs', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'ending.cjs, unsaved', exact: true }).waitFor();
  assert.equal(await ending.textContent(), 'CRLF');
  await editor.press('Control+z');
  assert.equal(await ending.textContent(), 'LF');
  await page.locator('#tabs').getByRole('button', { name: 'ending.cjs', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project, 'ending.cjs'), 'utf8'), 'const value = 1;\n');
});

test('a late format result cannot replace a newer editor version', { timeout: 25_000 }, async t => {
  const original = 'const before=1;\n';
  const workbench = await openWorkbench(t, { 'current.cjs': original });
  const { app, page, editor, open, project } = workbench;
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('cevra:format');
    ipcMain.handle('cevra:format', (_event, _workspace, _file, text, eol) => new Promise(resolve => {
      ipcMain.releaseHeldFormat = () => resolve({
        changes: [{ from: 0, to: text.length, insert: 'const oldResult = 1;\n' }],
        eol,
      });
      ipcMain.waitForHeldFormat?.();
    }));
  });
  await open('current.cjs');
  await page.getByRole('button', { name: 'Format document', exact: true }).click();
  await app.evaluate(({ ipcMain }) => {
    if (ipcMain.releaseHeldFormat) return;
    return new Promise(resolve => { ipcMain.waitForHeldFormat = resolve; });
  });
  await replaceEditor(workbench, 'const newerEdit=2;\n');
  await app.evaluate(({ ipcMain }) => ipcMain.releaseHeldFormat());
  await page.locator('#message').getByText('Formatting skipped because the document changed.', { exact: true }).waitFor();
  assert.equal((await editor.locator('.cm-line').allTextContents())[0], 'const newerEdit=2;');
  assert.equal(await fs.readFile(path.join(project, 'current.cjs'), 'utf8'), original);
});

test('Format Document reports invalid syntax while preserving unsaved text', async t => {
  const original = 'const value=1;\n';
  const workbench = await openWorkbench(t, { 'broken.js': original });
  const { page, editor, open, project } = workbench;
  await open('broken.js');
  await replaceEditor(workbench, 'const value = ;\n');
  await page.getByRole('button', { name: 'Format document', exact: true }).click();
  await page.locator('#message').getByText(/Fix the syntax error first/).waitFor();
  assert.equal((await editor.locator('.cm-line').allTextContents())[0], 'const value = ;');
  assert.equal(await fs.readFile(path.join(project, 'broken.js'), 'utf8'), original);
});
