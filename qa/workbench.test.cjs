const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { _electron } = require('playwright');
const { createWorkspace } = require('../src/workspace.cjs');
const { createPythonProfiles } = require('../src/execution/python-profiles.cjs');

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
  assert.fail('Windows process ' + pid + ' was still running after cleanup.');
}

const terminalTree = [
  'const { spawn } = require("node:child_process");',
  'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
  '  { stdio: "ignore", detached: true, windowsHide: true });',
  'child.once("spawn", () => console.log("TERMINAL-TREE " + process.pid + " " + child.pid));',
  'setInterval(() => {}, 1000);',
].join('\n');

async function waitForTerminalEcho(page, command) {
  await page.waitForFunction(text => {
    const lines = [...document.querySelectorAll('.terminal-surface:not([hidden]) .xterm-rows > div')];
    const output = lines.map(row => row.textContent).join('').replaceAll('\u00a0', ' ');
    return output.includes('> ' + text) || output.includes('>' + text);
  }, command);
}

async function startTerminalTree(page) {
  const active = page.locator('.terminal-surface:visible');
  const input = active.getByRole('textbox', { name: /terminal input/ });
  const rows = active.locator('.xterm-accessibility-tree');
  await rows.getByText(/PS .*project \(QA\)/).first().waitFor();
  const command = "& '" + process.execPath.replaceAll("'", "''") + "' .\\terminal-tree.cjs";
  await input.press('End');
  await page.keyboard.type(command);
  await waitForTerminalEcho(page, command);
  await input.press('Enter');
  const marker = /^TERMINAL-TREE (\d+) (\d+)$/;
  const pids = marker.exec((await rows.getByText(marker).textContent()).trim()).slice(1).map(Number);
  for (const pid of pids) process.kill(pid, 0);
  return pids;
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
      terminateMain: async () => {
        const pid = await app.evaluate(() => process.pid);
        const taskkill = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe');
        await execute(taskkill, ['/pid', String(pid), '/f'], { windowsHide: true });
        await assertWindowsProcessStopped(pid);
        app = undefined;
      },
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
  await result.page.getByRole('heading', { name: 'Choose a file to edit.' }).waitFor().catch(async error => {
    throw new Error('Could not open the fixture. ' + await result.page.locator('#message').textContent(), { cause: error });
  });
  return result;
}

test('Windows terminal runs PowerShell and Command Prompt independently and resizes the shell',
  { timeout: 40_000, skip: process.platform !== 'win32' }, async t => {
    const { app, page, project } = await openWorkbench(t, { 'notes.txt': 'Terminal fixture' });
    await page.keyboard.press('Control+Backquote');
    const open = page.getByRole('button', { name: 'New terminal', exact: true });
    const close = page.getByRole('button', { name: 'Close terminal', exact: true });
    const active = page.locator('.terminal-surface:visible');
    const rows = active.locator('.xterm-accessibility-tree');
    const visible = locator => locator.waitFor().catch(async error => {
      throw new Error((await page.locator('#terminal-panel').innerText()).slice(-4000), { cause: error });
    });
    const send = async text => {
      const input = active.getByRole('textbox', { name: /terminal input/ });
      await input.press('End');
      await page.keyboard.type(text);
      await waitForTerminalEcho(page, text);
      await input.press('Enter');
    };
    await open.click();
    await visible(rows.getByText(/PS .*project \(QA\)/).first());
    assert.match(await page.locator('#terminal-root').textContent(), /project \(QA\)/);
    const input = active.getByRole('textbox', { name: /terminal input/ });
    await input.press('Escape');
    const text = '$cevraValue = "café ✓"; Write-Output ("PTY " + $cevraValue)';
    await app.evaluate(({ clipboard }, value) => {
      // Exercise the app's clipboard bridge without replacing the user's clipboard.
      let contents = value;
      clipboard.readText = async () => contents;
      clipboard.writeText = async text => { contents = text; };
    }, text);
    await page.getByRole('button', { name: 'Paste', exact: true }).click();
    await waitForTerminalEcho(page, text);
    await input.press('Enter');
    await visible(rows.getByText('PTY café ✓', { exact: true }));

    await send('Write-Output ("ROWS:" + [Console]::WindowHeight)');
    const height = rows.getByText(/^ROWS:\d+$/).last();
    const initial = Number((await height.textContent()).split(':')[1]);
    const resize = page.getByRole('separator', { name: 'Resize bottom panel' });
    await resize.press('End');
    await page.waitForFunction(value =>
      document.querySelector('.terminal-surface:not([hidden]) .xterm-accessibility-tree').childElementCount > value, initial);
    await send('Write-Output ("NEWROWS:" + [Console]::WindowHeight)');
    const resized = Number((await rows.getByText(/^NEWROWS:\d+$/).textContent()).split(':')[1]);
    assert.ok(resized > initial);
    await send('Write-Host CEVRA-COLOR -ForegroundColor Green');
    const colored = active.locator('.xterm-rows :is(.xterm-fg-2, .xterm-fg-10)').getByText('CEVRA-COLOR', { exact: true });
    await visible(colored);
    const { x, y, width, height: rowHeight } = await colored.boundingBox();
    await page.mouse.click(x + width / 2, y + rowHeight / 2, { clickCount: 3 });
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await page.getByText('Selection copied.', { exact: true }).waitFor();
    assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /CEVRA-COLOR/);
    const lastLine = Math.max(60, resized * 3);
    const earlierLine = rows.getByText('LINE-' + (lastLine - resized - 1), { exact: true });
    await send('1..' + lastLine + ' | ForEach-Object { "LINE-$_" }');
    await visible(rows.getByText('LINE-' + lastLine, { exact: true }));
    assert.equal(await earlierLine.count(), 0);
    await active.getByRole('textbox', { name: /terminal input/ }).press('Shift+PageUp');
    await visible(earlierLine);

    await page.getByLabel('Shell', { exact: true }).selectOption('cmd');
    await open.click();
    await visible(rows.getByText(/project \(QA\).*?>/).first());
    await send('echo CEVRA-CMD');
    await rows.getByText('CEVRA-CMD', { exact: true }).waitFor();
    await send('cd');
    await visible(rows.getByText(project, { exact: true }));
    await page.getByRole('button', { name: 'PowerShell 1', exact: true }).click();
    await send('Write-Output ("STILL " + $cevraValue)');
    await rows.getByText('STILL café ✓', { exact: true }).waitFor();
    assert.equal(await rows.getByText('CEVRA-CMD', { exact: true }).count(), 0);
    await send('Write-Output CEVRA-SLEEPING; Start-Sleep -Seconds 60');
    const sleeping = rows.getByText('CEVRA-SLEEPING', { exact: true });
    await visible(sleeping);
    await active.getByRole('textbox', { name: /terminal input/ }).press('Control+c');
    await visible(sleeping.locator('xpath=following-sibling::*[1]').filter({ hasText: /^PS .*?>\s*$/ }));
    await send('Write-Output CEVRA-INTERRUPTED');
    await visible(rows.getByText('CEVRA-INTERRUPTED', { exact: true }));
    await close.click();
    await page.getByRole('button', { name: 'PowerShell 1', exact: true }).waitFor({ state: 'detached' });
    await rows.getByText('CEVRA-CMD', { exact: true }).waitFor();
    await send('exit 7');
    await page.getByText('Shell exited with code 7.', { exact: true }).waitFor();
  });

test('Windows terminal honors trust and cleans up a detached tree before switching workspaces',
  { timeout: 35_000, skip: process.platform !== 'win32' }, async t => {
    const { app, page, project } = await openWorkbench(t, { 'terminal-tree.cjs': terminalTree });
    const terminal = page.getByRole('button', { name: 'Terminal', exact: true });
    await terminal.click();
    const start = page.getByRole('button', { name: 'New terminal', exact: true });
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await start.click();
    await page.getByText('Terminal launch canceled.', { exact: true }).waitFor();
    assert.equal(await page.locator('.terminal-surface').count(), 0);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await start.click();
    const pids = await startTerminalTree(page);

    const next = path.join(path.dirname(project), 'next');
    await fs.mkdir(next);
    await fs.writeFile(path.join(next, 'new.txt'), 'next workspace');
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      dialog.showMessageBox = async () => ({ response: 0 });
    }, next);
    await page.locator('#open-folder').click();
    await page.locator('#open-folder').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.getElementById('open-folder').disabled);
    assert.equal(await page.locator('.terminal-surface').count(), 1);
    for (const pid of pids) process.kill(pid, 0);

    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await page.locator('#open-folder').click();
    await page.getByRole('button', { name: 'new.txt', exact: true }).waitFor();
    await Promise.all(pids.map(assertWindowsProcessStopped));
    assert.equal(await page.locator('.terminal-surface').count(), 0);
  });

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
  await state.getByText('Canceled', { exact: true }).waitFor();
  await assertWindowsProcessStopped(child);
});

test('Windows bounds a 12 MiB output flood and cancels the detached process tree before switching workspaces',
  { timeout: 30_000, skip: process.platform !== 'win32' }, async t => {
    const branch = [
      'const { spawn } = require("node:child_process");',
      'const leaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
      '  { stdio: "ignore", windowsHide: true, detached: true });',
      'leaf.once("spawn", () => console.log(leaf.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const flooding = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const branch = spawn(process.execPath, ["-e", ' + JSON.stringify(branch) + '],',
      '  { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, detached: true });',
      'branch.stdout.once("data", bytes => {',
      '  writeFileSync("tree.json", JSON.stringify([process.ppid, process.pid, branch.pid, Number(bytes)]));',
      '  const block = Buffer.alloc(128 * 1024, 120);',
      '  let count = 0;',
      '  function pump() {',
      '    if (++count > 96) return console.log("\\nFLOOD-TAIL café");',
      '    process.stdout.write(block, () => setTimeout(pump, 15));',
      '  }',
      '  pump();',
      '});',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const { app, editor, page, project, open, state, output } = await openWorkbench(t, {
      'flood.cjs': flooding, 'notes.txt': 'Can still edit',
    });
    await open('flood.cjs');
    await editor.press('F5');
    const notice = page.locator('#output-truncated');
    await notice.waitFor();
    assert.equal(await page.locator('#open-folder').isDisabled(), true);
    const refused = await page.evaluate(() => window.cevra.chooseFolder(false).then(() => '', error => error.message));
    assert.match(refused, /Stop the current run before opening another project/);

    await open('notes.txt');
    await editor.press('End');
    await page.keyboard.insertText(' while output streams');
    assert.equal(await editor.textContent(), 'Can still edit while output streams');
    await output.getByText(/FLOOD-TAIL café/).waitFor();
    assert.ok((await output.textContent()).length <= 160_000);
    await page.getByRole('button', { name: 'Failure Lens', exact: true }).click();
    await page.locator('#failure-truncated').waitFor();
    const failureOutput = page.locator('#failure-output');
    await failureOutput.getByText(/FLOOD-TAIL café/).waitFor();
    assert.ok((await failureOutput.textContent()).length <= 160_000);
    await page.getByRole('button', { name: 'Run output', exact: true }).click();
    const pids = JSON.parse(await fs.readFile(path.join(project, 'tree.json'), 'utf8'));
    assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
    for (const pid of pids) process.kill(pid, 0);

    await page.getByRole('button', { name: 'Stop run', exact: true }).click();
    await state.getByText('Canceled', { exact: true }).waitFor();
    await Promise.all(pids.map(assertWindowsProcessStopped));
    await notice.waitFor();
    assert.match(await output.textContent(), /FLOOD-TAIL café/);
    const next = path.join(path.dirname(project), 'next workspace');
    await fs.mkdir(next);
    await fs.writeFile(path.join(next, 'fresh.cjs'), 'console.log("fresh workspace");\n');
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, next);
    await page.locator('#open-folder').click();
    await open('fresh.cjs');
    await editor.press('F5');
    await state.getByText(/^Passed/).waitFor();
    assert.match(await output.textContent(), /fresh workspace/);
    assert.doesNotMatch(await output.textContent(), /FLOOD-TAIL/);
  });

test('Windows reaps a detached child when the entry script exits normally',
  { timeout: 20_000, skip: process.platform !== 'win32' }, async t => {
    const { editor, open, state, output } = await openWorkbench(t, {
      'early-exit.cjs': [
        'const child = require("node:child_process").spawn(process.execPath,',
        '  ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true, windowsHide: true });',
        'child.once("spawn", () => console.log("detached " + child.pid));',
        'child.unref();',
      ].join('\n'),
    });
    await open('early-exit.cjs');
    await editor.press('F5');
    await state.getByText(/^Passed/).waitFor();
    const match = /detached (\d+)/.exec(await output.textContent());
    assert.ok(match);
    await assertWindowsProcessStopped(Number(match[1]));
  });

test('Windows cleans up a running test tree after only the Electron main process is killed',
  { timeout: 35_000, skip: process.platform !== 'win32' }, async t => {
    const workbench = await openWorkbench(t, {
      'supervised.test.cjs': [
        'const { test } = require("node:test");',
        'const { spawn } = require("node:child_process");',
        'test("supervised", async () => {',
        '  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
        '    { stdio: "ignore", detached: true, windowsHide: true });',
        '  child.once("spawn", () => console.log("test tree " + [process.ppid, process.pid, child.pid].join(" ")));',
        '  await new Promise(resolve => setTimeout(resolve, 30000));',
        '});',
      ].join('\n'),
    });
    const run = workbench.page.getByRole('button', { name: 'Run tests', exact: true });
    await run.click();
    const pattern = /test tree (\d+) (\d+) (\d+)/;
    await workbench.output.getByText(pattern).waitFor();
    const canceled = pattern.exec(await workbench.output.textContent()).slice(1).map(Number);
    await workbench.page.getByRole('button', { name: 'Stop run', exact: true }).click();
    await workbench.state.getByText('Canceled', { exact: true }).waitFor();
    await workbench.page.locator('#test-revision').getByText('Run canceled', { exact: true }).waitFor();
    await Promise.all(canceled.map(assertWindowsProcessStopped));

    await run.click();
    await workbench.output.getByText(pattern).waitFor();
    const pids = pattern.exec(await workbench.output.textContent()).slice(1).map(Number);
    for (const pid of pids) process.kill(pid, 0);
    await workbench.terminateMain();
    await Promise.all(pids.map(assertWindowsProcessStopped));
  });

test('canceling while a run saves its input prevents the process from launching', { timeout: 25_000 }, async t => {
  const original = 'require("node:fs").writeFileSync("launched.txt", "ran");\n';
  const edited = '// draft\n' + original;
  const { app, page, editor, open, project, state } = await openWorkbench(t, { 'save.cjs': original });
  const revision = createHash('sha256').update(edited).digest('hex');
  await app.evaluate(({ ipcMain }, nextRevision) => {
    ipcMain.removeHandler('cevra:save');
    ipcMain.handle('cevra:save', () => new Promise(resolve => {
      ipcMain.releaseExecutionSave = () => resolve(nextRevision);
      ipcMain.onExecutionSave?.();
    }));
  }, revision);
  await open('save.cjs');
  await replaceEditor({ editor, page }, edited);
  await editor.press('F5');
  try {
    await app.evaluate(({ ipcMain }) => ipcMain.releaseExecutionSave ?
      undefined : new Promise(resolve => { ipcMain.onExecutionSave = resolve; }));
    await page.getByRole('button', { name: 'Stop run', exact: true }).click();
    await state.getByText('Stopping', { exact: true }).waitFor();
    await fs.writeFile(path.join(project, 'save.cjs'), edited);
  } finally {
    await app.evaluate(({ ipcMain }) => ipcMain.releaseExecutionSave?.());
  }
  await state.getByText('Canceled', { exact: true }).waitFor();
  await assert.rejects(fs.access(path.join(project, 'launched.txt')), { code: 'ENOENT' });
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

test('a named test workstream links an exact failure and marks edited or external inputs historical',
  { timeout: 30_000 }, async t => {
    const folder = 'nested (# % &) café';
    const source = path.join(folder, 'total.cjs');
    const workbench = await openWorkbench(t, {
      [source]: 'module.exports = function total() {\n  const value = 1;\n  throw new Error("incorrect total");\n};\n',
      'config.json': '{"round":false}\n',
      'totals.test.cjs': "const { test } = require('node:test');\n" +
        "const total = require(" + JSON.stringify('./' + folder + '/total.cjs') + ");\n" +
        "test('invoice total', () => total());\n",
    });
    const { page, project, editor, selected, state } = workbench;
    const run = page.getByRole('button', { name: 'Run tests', exact: true });
    const status = page.locator('#test-revision');
    await page.getByRole('button', { name: 'Run output', exact: true }).click();
    const goal = page.getByRole('textbox', { name: 'Workstream' });
    await goal.fill('Repair the invoice total');
    await run.click();
    await state.getByText(/^Failed/).waitFor();
    await status.getByText(/^Workspace inputs observed · [a-f0-9]{10}$/).waitFor();
    assert.match(await status.getAttribute('title'), /^Repair the invoice total/);
    const failure = page.getByRole('button', { name: /invoice total.*total\.cjs:3:9/ });
    await failure.click();
    await selected('total.cjs').waitFor();
    await page.locator('#cursor').getByText('Ln 3, Col 9', { exact: true }).waitFor();

    await replaceEditor(workbench, 'module.exports = () => 1;\n');
    await status.getByText(/^Historical · workspace inputs changed/).waitFor();
    await failure.click();
    await page.locator('#message').getByText(/recorded test source changed/).waitFor();
    assert.match(await editor.textContent(), /module.exports = \(\) => 1/);

    await run.click();
    await state.getByText(/^Passed/).waitFor();
    await status.getByText(/^Workspace inputs observed/).waitFor();
    assert.equal(await goal.inputValue(), 'Repair the invoice total');
    await fs.writeFile(path.join(project, 'config.json'), '{"round":true}\n');
    await page.getByRole('button', { name: 'Check inputs' }).click();
    await status.getByText(/^Historical · workspace inputs changed/).waitFor();
    await state.getByText(/^Historical pass/).waitFor();
    assert.equal(await state.getAttribute('data-state'), '');
  });

test('Flightpath keeps opt-in capsules across a crash and shows reopened passes as historical',
  { timeout: 45_000 }, async t => {
    let workbench = await openWorkbench(t, {
      'checks.test.cjs': 'const { test } = require("node:test");\ntest("totals", () => console.log("private test output"));\n',
      'config.json': '{"round":false}\n',
    });
    const { page, profile, state } = workbench;
    const run = page.getByRole('button', { name: 'Run tests', exact: true });
    const flightpath = page.getByRole('button', { name: 'Flightpath', exact: true });
    const capsules = page.getByRole('list', { name: 'Run Capsules, newest first' }).getByRole('listitem');
    await run.click();
    await state.getByText(/^Passed/).waitFor();
    await flightpath.click();
    await page.getByText(/^Local history is off/).waitFor();
    assert.equal(await capsules.count(), 0);
    const storage = path.join(profile, 'flightpath');
    await assert.rejects(fs.stat(storage), { code: 'ENOENT' });
    await page.getByRole('button', { name: 'Enable local history' }).click();
    await page.getByText(/^Local history is on/).waitFor();
    assert.equal(await capsules.count(), 0);

    await page.getByRole('button', { name: 'Test results', exact: true }).click();
    await page.getByRole('textbox', { name: 'Workstream' }).fill('private goal');
    await run.click();
    await state.getByText(/^Passed/).waitFor();
    await flightpath.click();
    await capsules.first().getByText(/^Workspace inputs observed/).waitFor();
    assert.equal(await capsules.count(), 1);
    const firstRevision = await capsules.first().locator('span[title]').getAttribute('title');

    await workbench.open('config.json');
    await replaceEditor(workbench, '{"round":true}\n');
    await capsules.first().getByText(/^Historical/).waitFor();
    await run.click();
    await state.getByText(/^Passed/).waitFor();
    await flightpath.click();
    await capsules.first().getByText(/^Workspace inputs observed/).waitFor();
    assert.equal(await capsules.count(), 2);
    assert.notEqual(await capsules.first().locator('span[title]').getAttribute('title'), firstRevision);
    await capsules.nth(1).getByText(/^Historical/).waitFor();
    const [key] = await fs.readdir(storage);
    const journal = path.join(storage, key, 'journal.json');
    const retained = await fs.readFile(journal, 'utf8');
    assert.doesNotMatch(retained, /private goal|private test output|config\.json|checks\.test\.cjs/);

    workbench = await workbench.restart({ crash: true });
    await workbench.page.locator('#open-folder').click();
    await workbench.page.getByRole('button', { name: 'Flightpath', exact: true }).click();
    const reopened = workbench.page.getByRole('list', { name: 'Run Capsules, newest first' }).getByRole('listitem');
    await reopened.nth(1).getByText(/^Historical/).waitFor();
    await reopened.first().getByText(/^Historical/).waitFor();
    assert.equal(await reopened.count(), 2);
    await workbench.page.getByRole('button', { name: 'Clear history', exact: true }).click();
    await reopened.first().waitFor({ state: 'detached' });
    assert.deepEqual(JSON.parse(await fs.readFile(journal, 'utf8')).data.capsules, []);
    await workbench.page.getByRole('button', { name: 'Turn off and clear', exact: true }).click();
    await workbench.page.getByText(/^Local history is off/).waitFor();
    await assert.rejects(fs.stat(journal), { code: 'ENOENT' });
  });

test('Task Weave rejects stale plans, links build errors, and records graph outcomes in Flightpath',
  { timeout: 45_000 }, async t => {
    const source = 'nested (QA)/fail café.cjs';
    const manifest = { scripts: {
      check: 'node -e "console.log(\'STEP-PREPARED\')"', build: 'node "' + source + '"',
      test: 'node -e "console.log(\'STEP-VERIFIED\')"', prebuild: 'node -e "console.log(\'IMPLICIT-STEP\')"',
    } };
    const workbench = await openWorkbench(t, {
      'package.json': JSON.stringify(manifest),
      '.cevra-tasks.json': JSON.stringify({ schemaVersion: 1, tasks: [
        { id: 'prepare', profile: 'check', after: [] },
        { id: 'compile', profile: 'build', after: ['prepare'] },
        { id: 'verify', profile: 'test', after: ['compile'] },
      ] }),
      [source]: '\nthrow new Error("nested build failure");\n',
    });
    const { page, project, state, output } = workbench;
    const tasks = page.getByRole('button', { name: 'Tasks', exact: true });
    const flightpath = page.getByRole('button', { name: 'Flightpath', exact: true });
    const choose = page.getByLabel('Task', { exact: true });
    const run = page.getByRole('button', { name: 'Run task', exact: true });
    const steps = page.getByRole('list', { name: 'Task steps' }).getByRole('listitem');
    await flightpath.click();
    await page.getByRole('button', { name: 'Enable local history' }).click();
    await page.getByText(/^Local history is on/).waitFor();
    await tasks.click();
    await choose.selectOption('dag:verify');
    const plan = page.getByRole('list', { name: 'Task plan in execution order' }).getByRole('listitem');
    assert.deepEqual(await plan.locator('strong').allTextContents(), [
      'prepare · npm --ignore-scripts run check', 'compile · npm --ignore-scripts run build', 'verify · npm --ignore-scripts run test',
    ]);
    assert.match(await plan.nth(1).innerText(), /After prepare/);
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ ...manifest, version: '1.0.0' }));
    await run.click();
    await state.getByText('Could not run', { exact: true }).waitFor();
    await output.getByText(/Task scripts or dependencies changed/).waitFor();
    assert.doesNotMatch(await output.textContent(), /STEP-PREPARED/);

    await tasks.click();
    await choose.selectOption('dag:verify');
    await run.click();
    await state.getByText('Task failed', { exact: true }).waitFor();
    await steps.nth(0).getByText('Passed', { exact: true }).waitFor();
    await steps.nth(1).getByText('Failed', { exact: true }).waitFor();
    await steps.nth(2).getByText('Dependency compile did not pass', { exact: true }).waitFor();
    assert.match(await output.textContent(), /STEP-PREPARED[\s\S]*nested build failure/);
    assert.doesNotMatch(await output.textContent(), /STEP-VERIFIED|IMPLICIT-STEP/);
    const link = steps.nth(1).getByRole('button', { name: /fail café\.cjs:2:7/ });
    await link.click();
    await workbench.selected('fail café.cjs').waitFor();
    await page.locator('#cursor').getByText('Ln 2, Col 7', { exact: true }).waitFor();
    await replaceEditor(workbench, 'console.log("STEP-COMPILED");\n');
    await link.click();
    await page.locator('#message').getByText(/recorded task source changed/).waitFor();

    await tasks.click();
    await choose.selectOption('dag:verify');
    await run.click();
    await state.getByText(/^Completed ·/).waitFor();
    assert.match(await output.textContent(), /STEP-PREPARED[\s\S]*STEP-COMPILED[\s\S]*STEP-VERIFIED/);
    await flightpath.click();
    const capsules = page.getByRole('list', { name: 'Run Capsules, newest first' }).getByRole('listitem');
    await capsules.first().getByText(/^Workspace inputs observed/).waitFor();
    assert.deepEqual(await capsules.locator('strong').allTextContents(), [
      'Task verify · Passed', 'Task compile · Passed', 'Task prepare · Passed',
      'Task verify · Blocked', 'Task compile · Failed', 'Task prepare · Passed',
    ]);
  });

test('Windows Task Weave respects trust and Stop ends detached children and blocks later tasks',
  { timeout: 35_000, skip: process.platform !== 'win32' }, async t => {
    const { app, page, state, output } = await openWorkbench(t, {
      'package.json': JSON.stringify({ scripts: { build: 'node build.cjs', test: 'echo TASK-SHOULD-NOT-RUN' } }),
      '.cevra-tasks.json': JSON.stringify({ schemaVersion: 1, tasks: [
        { id: 'build', profile: 'build', after: [] },
        { id: 'verify', profile: 'test', after: ['build'] },
      ] }),
      'build.cjs': terminalTree.replace('TERMINAL-TREE', 'TASK-TREE'),
    });
    const tasks = page.getByRole('button', { name: 'Tasks', exact: true });
    const choose = page.getByLabel('Task', { exact: true });
    const run = page.getByRole('button', { name: 'Run task', exact: true });
    await tasks.click();
    await choose.selectOption('dag:verify');
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await run.click();
    await state.getByText('Canceled', { exact: true }).waitFor();
    assert.doesNotMatch(await output.textContent(), /TASK-TREE/);

    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await tasks.click();
    await choose.selectOption('dag:verify');
    await run.click();
    const marker = /TASK-TREE (\d+) (\d+)/;
    await output.getByText(marker).waitFor();
    const pids = marker.exec(await output.textContent()).slice(1).map(Number);
    for (const pid of pids) process.kill(pid, 0);
    await page.getByRole('button', { name: 'Stop run', exact: true }).click();
    await state.getByText('Canceled', { exact: true }).waitFor();
    await Promise.all(pids.map(assertWindowsProcessStopped));
    const steps = page.getByRole('list', { name: 'Task steps' }).getByRole('listitem');
    await steps.nth(0).getByText('Canceled', { exact: true }).waitFor();
    await steps.nth(1).getByText('Run canceled', { exact: true }).waitFor();
    assert.doesNotMatch(await output.textContent(), /TASK-SHOULD-NOT-RUN/);
  });

test('Runtime Fabric runs TypeScript and maps transformed runtime and syntax errors to original files',
  { timeout: 35_000 }, async t => {
    const childFile = 'nested (TS) & café/error # %.ts';
    const specifier = './' + childFile.split('/').map(encodeURIComponent).join('/');
    const workbench = await openWorkbench(t, {
      'package.json': '{"type":"module"}',
      'entry.mts': 'import { fail } from ' + JSON.stringify(specifier) + ';\nfail();\n',
      [childFile]: 'enum Mode { Ready = "ready" }\nexport function fail(): void {\n  throw new Error("TS runtime " + Mode.Ready);\n}\n',
      'hold.cts': [
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
        '  { stdio: "ignore", detached: true, windowsHide: true });',
        'child.once("spawn", () => console.log(`TS-TREE ${process.pid} ${child.pid}`));',
        'const interval: number = 1000;',
        'setInterval(() => {}, interval);',
      ].join('\n'),
    });
    const { page, editor, output, state } = workbench;
    const link = page.locator('#jump-to-error');
    await workbench.open('entry.mts');
    await editor.press('F5');
    await state.getByText(/^Failed/).waitFor();
    await output.getByText(/TS runtime ready/).waitFor();
    await link.getByText(/error # %\.ts:3:9/).waitFor().catch(async error => {
      throw new Error(await output.textContent(), { cause: error });
    });
    await link.click();
    await workbench.selected('error # %.ts').waitFor();
    await page.locator('#cursor').getByText('Ln 3, Col 9', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Failure Lens', exact: true }).click();
    await page.locator('#failure-output').getByText(/TS runtime ready/).waitFor();
    await page.getByRole('button', { name: /Recorded failure.*error # %\.ts:3:9/ }).click();
    await page.locator('#cursor').getByText('Ln 3, Col 9', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Run output', exact: true }).click();
    await replaceEditor(workbench, '// line one\nconst value: number = ;\n');
    await link.click();
    await page.locator('#message').getByText(/recorded runtime source changed/).waitFor();
    await editor.press('F5');
    await state.getByText(/^Failed/).waitFor();
    await output.getByText(/ERR_INVALID_TYPESCRIPT_SYNTAX/).waitFor();
    await link.getByText(/error # %\.ts:2:/).waitFor().catch(async error => {
      throw new Error(await output.textContent(), { cause: error });
    });
    await link.click();
    await page.locator('#cursor').getByText(/^Ln 2, Col /).waitFor();
    await replaceEditor(workbench, 'const value: number = 4;\nconsole.log("TS-SUCCESS", value);\n');
    await editor.press('F5');
    await state.getByText(/^Passed/).waitFor();
    await output.getByText(/TS-SUCCESS 4/).waitFor();

    await workbench.open('hold.cts');
    await editor.press('F5');
    const tree = /TS-TREE (\d+) (\d+)/;
    await output.getByText(tree).waitFor();
    const pids = tree.exec(await output.textContent()).slice(1).map(Number);
    await page.getByRole('button', { name: 'Stop run', exact: true }).click();
    await state.getByText('Canceled', { exact: true }).waitFor();
    await Promise.all(pids.map(assertWindowsProcessStopped));
  });

test('Runtime Fabric uses an explicitly selected Python virtual environment and supervises its runs',
  { timeout: 45_000 }, async t => {
    const entry = 'entry (#%) & café.py';
    const source = path.join('nested (PY)', 'failure café.py');
    const workbench = await openWorkbench(t, {
      [entry]: 'import runpy, sys\nprint("PY-PREFIX", sys.prefix)\nrunpy.run_path(' +
        JSON.stringify(source.replaceAll('\\', '/')) + ')\n',
      [source]: 'def fail():\n    raise ValueError("python café")\n\nfail()\n',
      'done.py': 'import sys\nprint("PY-SUCCESS", sys.executable)\n',
      'hold.py': [
        'import os, subprocess, sys, time',
        'flags = subprocess.DETACHED_PROCESS if sys.platform == "win32" else 0',
        'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], creationflags=flags)',
        'print("PY-TREE", os.getpid(), child.pid)',
        'time.sleep(60)',
      ].join('\n'),
    });
    const { app, page, project, editor, output, state } = workbench;
    const profiles = await createPythonProfiles(await createWorkspace(project)).list();
    assert.ok(profiles.length, 'Install Python 3 and put its executable on PATH for the desktop suite.');
    const venv = path.join(project, '.venv');
    await execute(profiles[0].file, ['-m', 'venv', '--without-pip', venv], { timeout: 15_000, windowsHide: true });
    const python = page.getByLabel('Python interpreter', { exact: true });
    await workbench.open(entry);
    await editor.press('F5');
    await page.locator('#message').getByText(/Choose a Python interpreter/).waitFor();
    assert.doesNotMatch(await output.textContent(), /PY-PREFIX/);
    await python.selectOption({ label: 'Workspace .venv · ' + path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3') });
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await editor.press('F5');
    await state.getByText('Canceled', { exact: true }).waitFor();
    assert.doesNotMatch(await output.textContent(), /PY-PREFIX/);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await editor.press('F5');
    await state.getByText(/^Failed/).waitFor();
    await output.getByText(/ValueError: python café/).waitFor();
    assert.ok((await output.textContent()).includes('PY-PREFIX ' + venv));
    const link = page.locator('#jump-to-error');
    await link.getByText(/failure café\.py:2:/).waitFor();
    await link.click();
    await workbench.selected('failure café.py').waitFor();
    await page.locator('#cursor').getByText(/^Ln 2, Col /).waitFor();
    await replaceEditor(workbench, '# line one\nvalue =\n');
    await editor.press('F5');
    await state.getByText(/^Failed/).waitFor();
    await output.getByText(/SyntaxError:/).waitFor();
    await link.getByText(/failure café\.py:2:/).waitFor();

    await workbench.open('hold.py');
    await editor.press('F5');
    const tree = /PY-TREE (\d+) (\d+)/;
    await output.getByText(tree).waitFor();
    const pids = tree.exec(await output.textContent()).slice(1).map(Number);
    await page.getByRole('button', { name: 'Stop run', exact: true }).click();
    await state.getByText('Canceled', { exact: true }).waitFor();
    await Promise.all(pids.map(assertWindowsProcessStopped));
    const selectedExe = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
    await fs.rename(selectedExe, selectedExe + '.removed');
    await editor.press('F5');
    await state.getByText('Could not run', { exact: true }).waitFor();
    await output.getByText(/Python interpreter changed or is unavailable/).waitFor();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, profiles[0].file);
    await page.getByRole('button', { name: 'Choose Python executable', exact: true }).click();
    await page.locator('#python-status').getByText(profiles[0].file, { exact: true }).waitFor();
    await workbench.open('done.py');
    await editor.press('F5');
    await state.getByText(/^Passed/).waitFor();
    await output.getByText(/PY-SUCCESS/).waitFor();
  });

test('Failure Lens debugs a nested JavaScript breakpoint, steps, and keeps an uncaught failure with source',
  { timeout: 42_000 }, async t => {
    const folder = 'nested (Debug) & café';
    const name = 'amount # %.cjs';
    const workbench = await openWorkbench(t, {
      'entry.cjs': `require(${JSON.stringify('./' + folder + '/' + name)}).work(19);\n`,
      [path.join(folder, name)]: [
        'exports.work = function work(seed) {',
        '  const amount = seed + 2;',
        '  const twice = double(amount);',
        '  console.log("DEBUG-OUTPUT", twice);',
        '  throw new Error("debugger failure " + twice);',
        '};',
        'function double(x) {',
        '  return x * 2;',
        '}',
      ].join('\n') + '\n',
    });
    const { page, editor } = workbench;
    const lens = page.getByRole('region', { name: 'Failure Lens', exact: true });
    const status = page.locator('#debug-status');
    const stack = lens.getByRole('list', { name: 'Call stack', exact: true });
    const variables = page.locator('#debug-variables');
    const breakpoint = lens.getByRole('list', { name: 'Breakpoints', exact: true });
    const button = name => lens.getByRole('button', { name, exact: true });
    await workbench.file(folder).click();
    await workbench.open(name);
    const line = await editor.locator('.cm-line').nth(2).boundingBox();
    const gutter = await page.locator('.cm-debug-gutter').boundingBox();
    await page.mouse.click(gutter.x + gutter.width / 2, line.y + line.height / 2);
    await page.getByRole('button', { name: 'Failure Lens', exact: true }).click();
    await breakpoint.getByText(/amount # %\.cjs:3 · pending/).waitFor();
    await button('Disable breakpoint').click();
    await breakpoint.getByText(/:3 · disabled/).waitFor();
    await button('Enable breakpoint').click();
    await workbench.open('entry.cjs');
    await button('Debug file').click();
    await status.getByText('Paused · Entry', { exact: true }).waitFor();
    await button('Continue').click();
    await status.getByText('Paused · Breakpoint', { exact: true }).waitFor().catch(async error => {
      throw new Error((await lens.innerText()).slice(0, 3500), { cause: error });
    });
    await breakpoint.getByText(/:3 · verified/).waitFor();
    await variables.getByText('amount', { exact: true }).waitFor();
    await variables.getByText('21', { exact: true }).waitFor();

    const workFrame = stack.getByRole('button', { name: /work · .*amount # %\.cjs:3:/ });
    await workFrame.click();
    await workbench.selected(name).waitFor();
    await page.locator('#cursor').getByText(/^Ln 3,/).waitFor();
    await page.locator('.debug-marker[title="Paused here"]').waitFor();
    await stack.getByRole('button', { name: /entry\.cjs:1:/ }).click();
    await workbench.selected('entry.cjs').waitFor();
    await button('Step into').click();
    await stack.getByRole('button', { name: /double · .*amount # %\.cjs:8:/ }).waitFor();
    await variables.getByText('x', { exact: true }).waitFor();
    await button('Step out').click();
    await stack.getByRole('button', { name: /work · .*amount # %\.cjs:4:/ }).waitFor();
    await button('Step over').click();
    const throwFrame = stack.getByRole('button', { name: /work · .*amount # %\.cjs:5:/ });
    await throwFrame.waitFor();
    await page.locator('#failure-output').getByText(/DEBUG-OUTPUT 42/).waitFor();
    await button('Continue').click();
    await status.getByText('Paused · Exception', { exact: true }).waitFor();
    await page.locator('#debug-summary').getByText('Error: debugger failure 42', { exact: true }).waitFor();
    await throwFrame.click();
    await workbench.selected(name).waitFor();
    await page.locator('#cursor').getByText(/^Ln 5,/).waitFor();
    await replaceEditor(workbench, '// draft changed while paused\n');
    await throwFrame.click();
    await page.locator('#message').getByText(/recorded debug source changed/).waitFor();
    assert.match(await editor.textContent(), /draft changed while paused/);
    await button('Continue').click();
    await status.getByText('Run failed', { exact: true }).waitFor();
    await stack.getByRole('button', { name: /work · .*amount # %\.cjs:5:/ }).waitFor();
    await variables.getByText('Variables are available while paused.', { exact: true }).waitFor();
  });

test('Windows debugger requires workspace trust and Pause, Restart, and Stop supervise detached children',
  { timeout: 40_000, skip: process.platform !== 'win32' }, async t => {
    const workbench = await openWorkbench(t, { 'hold.cjs': terminalTree.replace('TERMINAL-TREE', 'DEBUG-TREE') });
    const { app, page, editor } = workbench;
    const status = page.locator('#debug-status');
    const output = page.locator('#failure-output');
    const lens = page.getByRole('region', { name: 'Failure Lens', exact: true });
    const button = name => lens.getByRole('button', { name, exact: true });
    const marker = /DEBUG-TREE (\d+) (\d+)/;
    async function runningTree() {
      await button('Continue').click();
      await output.getByText(marker).waitFor();
      const pids = marker.exec(await output.textContent()).slice(1).map(Number);
      for (const pid of pids) process.kill(pid, 0);
      return pids;
    }
    await workbench.open('hold.cjs');
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await editor.press('F6');
    await status.getByText('Debug session stopped', { exact: true }).waitFor();
    assert.doesNotMatch(await output.textContent(), marker);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await button('Debug file').click();
    await status.getByText('Paused · Entry', { exact: true }).waitFor();
    const first = await runningTree();
    await button('Pause').click();
    await status.getByText(/^Paused(?: ·|$)/).waitFor();
    await button('Restart debugger').click();
    await status.getByText('Paused · Entry', { exact: true }).waitFor();
    await Promise.all(first.map(assertWindowsProcessStopped));
    const second = await runningTree();
    assert.notEqual(first[0], second[0]);
    await button('Stop debugging').click();
    await status.getByText('Debug session stopped', { exact: true }).waitFor();
    await Promise.all(second.map(assertWindowsProcessStopped));

    await button('Restart debugger').click();
    await status.getByText('Paused · Entry', { exact: true }).waitFor();
    const third = await runningTree();
    await button('Pause').click();
    await status.getByText(/^Paused(?: ·|$)/).waitFor();
    const replacement = app.waitForEvent('window', { timeout: 12_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    const recovered = await replacement;
    await Promise.all(third.map(assertWindowsProcessStopped));
    await recovered.getByRole('button', { name: 'Failure Lens', exact: true }).click();
    assert.equal(await recovered.locator('#debug-stack li').count(), 0);
    assert.ok(await recovered.getByRole('button', { name: 'Continue', exact: true }).isDisabled());
  });

test('project replacement rejects a changed file, then recovers the entire confirmed batch after a crash',
  { timeout: 35_000 }, async t => {
    const first = 'const token = "token";\n';
    const nested = path.join('nested (# % &)', 'café.txt');
    const original = '\uFEFFtoken\r\nuntouched\r\n';
    const workbench = await openWorkbench(t, { 'main.js': first, [nested]: original });
    const { page, editor, open, project } = workbench;
    await open('main.js');
    await replaceEditor(workbench, '// unsaved token\n' + first);
    await editor.press('Control+Shift+f');
    await page.locator('#search-query').fill('token');
    await page.locator('#replace-text').fill('replacement');
    const showPreview = page.getByRole('button', { name: 'Preview Replace' });
    const dialog = page.getByRole('dialog', { name: 'Replace in Project' });
    const apply = dialog.getByRole('button', { name: 'Apply as Drafts' });
    await showPreview.click();
    await dialog.getByText(/4 edits in 2 files/).waitFor();
    await dialog.getByText(/main\.js · 3 edits · unsaved buffer/).waitFor();
    await fs.writeFile(path.join(project, nested), original + 'external change\r\n');
    await apply.click();
    await dialog.getByText(/original changed or is unavailable/).waitFor();
    assert.match(await editor.textContent(), /unsaved token/);
    assert.equal(await fs.readFile(path.join(project, 'main.js'), 'utf8'), first);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('#search-query').press('Enter');
    await showPreview.click();
    await apply.click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await fs.readFile(path.join(project, 'main.js'), 'utf8'), first);
    assert.equal(await fs.readFile(path.join(project, nested), 'utf8'), original + 'external change\r\n');
    const recovered = await workbench.restart({ crash: true });
    await recovered.page.locator('#message').getByText('Recovered 2 unsaved files.').waitFor();
    await recovered.page.locator('#tabs').getByRole('button', { name: 'main.js, unsaved', exact: true }).click();
    assert.match(await recovered.editor.textContent(), /unsaved replacement/);
    await recovered.editor.press('Control+Shift+s');
    await recovered.page.locator('#draft-status[data-state="clear"]').waitFor({ state: 'attached' });
    assert.equal(await fs.readFile(path.join(project, nested), 'utf8'),
      '\uFEFFreplacement\r\nuntouched\r\nexternal change\r\n');
  });

test('Rename Symbol previews static cross-file edits, rejects collisions, and preserves per-file undo',
  { timeout: 30_000 }, async t => {
    const source = 'export function total(value: number) { return value; }\n// total stays in comments\n';
    const client = 'import { total } from "./main";\nconst taken = total(3);\nconst text = "total";\n';
    const { page, editor, open, project } = await openWorkbench(t, { 'main.ts': source, 'client.ts': client });
    await open('main.ts');
    await editor.press('Home');
    for (let index = 0; index < source.indexOf('total') + 2; index++) await editor.press('ArrowRight');
    await editor.press('F2');
    const dialog = page.getByRole('dialog', { name: 'Rename Symbol' });
    const field = dialog.getByRole('textbox', { name: 'New identifier' });
    await field.fill('taken');
    await field.press('Enter');
    await dialog.getByText(/identifier already exists/).waitFor();
    await field.fill('calculateTotal');
    await field.press('Enter');
    await dialog.locator('summary').filter({ hasText: 'client.ts' }).waitFor();
    await dialog.locator('summary').filter({ hasText: 'main.ts' }).waitFor();
    await fs.writeFile(path.join(project, 'outside-preview.ts'), 'export const calculateTotal = 0;\n');
    await dialog.getByRole('button', { name: 'Apply as Drafts' }).click();
    await dialog.getByText(/identifier already exists/).waitFor();
    assert.match(await editor.textContent(), /function total/);
    await fs.unlink(path.join(project, 'outside-preview.ts'));
    await field.press('Enter');
    await dialog.getByRole('button', { name: 'Apply as Drafts' }).click();
    await dialog.waitFor({ state: 'hidden' }).catch(async error => {
      throw new Error(await page.locator('#edits-status').textContent(), { cause: error });
    });
    assert.match(await editor.textContent(), /function calculateTotal/);
    assert.match(await editor.textContent(), /total stays in comments/);
    await page.locator('#tabs').getByRole('button', { name: 'client.ts, unsaved', exact: true }).click();
    assert.match(await editor.textContent(), /import \{ calculateTotal/);
    assert.match(await editor.textContent(), /text = "total"/);
    await editor.press('Control+z');
    assert.match(await editor.textContent(), /import \{ total \}/);
    assert.equal(await fs.readFile(path.join(project, 'main.ts'), 'utf8'), source);
    assert.equal(await fs.readFile(path.join(project, 'client.ts'), 'utf8'), client);
  });

test('type checking follows unsaved imports and jumps to the exact active-file issue', { timeout: 25_000 }, async t => {
  const workbench = await openWorkbench(t, {
    'source.ts': 'export const count: string = "3";\n',
    'client.ts': 'import { count } from "./source";\nconst result: number = count;\n',
  });
  const { page, editor, open } = workbench;
  await open('client.ts');
  await editor.press('Control+Shift+m');
  const type = page.locator('#type-list');
  const issue = type.getByRole('button', { name: /TS2322.*string.*number/ });
  await issue.click();
  await page.waitForFunction(() => window.getSelection().toString() === 'result');
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'result');
  await page.locator('#problems-status').getByText('No syntax problems.', { exact: true }).waitFor();
  await open('source.ts');
  await replaceEditor(workbench, 'export const count: number = 3;\n');
  await open('client.ts');
  await page.locator('#type-status').getByText('No type problems.', { exact: true }).waitFor();
  assert.equal(await type.getByRole('button').count(), 0);
});

test('editor settings apply to open tabs and workspace overrides persist after restart', { timeout: 30_000 }, async t => {
  const workbench = await openWorkbench(t, { 'source.js': 'function example(){\nreturn 1;\n}\n' });
  const { page, open, editor, project } = workbench;
  await open('source.js');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Editor Settings' });
  await dialog.getByText(/override global settings/).waitFor();
  await dialog.getByLabel('Font size').fill('21');
  await dialog.getByLabel('Indent width').fill('4');
  await dialog.getByLabel('Wrap lines').check();
  await dialog.getByLabel('Show line numbers').uncheck();
  await dialog.getByLabel('Format JavaScript and TypeScript on save').check();
  await dialog.getByRole('button', { name: 'Save Settings' }).click();
  await dialog.getByText('Settings saved.').waitFor();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.locator('#editor').getAttribute('data-line-numbers'), 'false');
  await page.locator('.cm-lineNumbers').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.cm-editor').evaluate(el => getComputedStyle(el).fontSize), '21px');
  assert.match(await editor.getAttribute('class'), /cm-lineWrapping/);
  await replaceEditor(workbench, 'function example(){return 2;}');
  await editor.press('Control+s');
  await page.locator('#message').getByText('Saved source.js').waitFor();
  assert.match(await fs.readFile(path.join(project, 'source.js'), 'utf8'), /function example\(\) \{\n  return 2;/);
  const reopened = await workbench.restart();
  await reopened.page.locator('#open-folder').click();
  await reopened.open('source.js');
  assert.equal(await reopened.page.locator('.cm-editor').evaluate(el => getComputedStyle(el).fontSize), '21px');
});

test('workspace execution requires a grant and canceling leaves disk unchanged', { timeout: 30_000 }, async t => {
  const original = 'console.log("original");\n';
  const workbench = await openWorkbench(t, { 'source.cjs': original });
  const { app, page, open, editor, state, output, project } = workbench;
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
  });
  await open('source.cjs');
  await replaceEditor(workbench, 'console.log("confirmed");\n');
  await editor.press('F5');
  await state.getByText('Canceled', { exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project, 'source.cjs'), 'utf8'), original);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 2 });
  });
  await editor.press('F5');
  await output.getByText('confirmed', { exact: true }).waitFor();
  await state.getByText(/^Passed/).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Editor Settings' });
  await settings.getByText('Workspace execution is trusted.').waitFor();
  await settings.getByRole('button', { name: 'Revoke Trust' }).click();
  await settings.getByText('CEVRA will ask before running workspace code.').waitFor();
  const rejected = await page.evaluate(async () => {
    const { project } = await window.cevra.initial();
    const { revision } = await window.cevra.read(project.id, 'source.cjs');
    return window.cevra.start(project.id, 'source.cjs', revision, 777).then(() => '', error => error.message);
  });
  assert.match(rejected, /Authorize workspace execution first/);
});

async function waitForTheme(page, choice, scheme) {
  await page.waitForFunction(({ choice, scheme }) => {
    const select = document.getElementById('theme-choice');
    return !select.disabled && select.value === choice && getComputedStyle(document.documentElement).colorScheme === scheme;
  }, { choice, scheme });
}

test('switching themes updates the window and editor and preserves drafts and undo across tabs',
  { timeout: 35_000 }, async t => {
  const first = 'const first = 1;\n';
  const second = 'const second = "original";\n';
  let workbench = await openWorkbench(t, { 'first.ts': first, 'second.js': second });
  const { app, page, editor, open, project } = workbench;
  const theme = page.getByRole('combobox', { name: 'Theme' });
  await waitForTheme(page, 'dark', 'dark');
  await open('first.ts');
  await replaceEditor(workbench, 'const first = 42;\n');
  await open('second.js');
  const draft = 'const second = "draft";\n';
  await replaceEditor(workbench, draft);
  await editor.press('Control+Home');
  await editor.press('Shift+End');
  const cursor = await page.locator('#cursor').textContent();
  const keyword = editor.getByText('const', { exact: true });
  assert.equal(await keyword.evaluate(element => getComputedStyle(element).color), 'rgb(217, 173, 251)');

  await theme.selectOption('light');
  await waitForTheme(page, 'light', 'light');
  assert.equal(await keyword.evaluate(element => getComputedStyle(element).color), 'rgb(102, 51, 140)');
  assert.deepEqual(await page.evaluate(() => ['.titlebar', '.cm-editor', '.run-panel'].map(selector =>
    getComputedStyle(document.querySelector(selector)).backgroundColor)), [
    'rgb(239, 244, 239)', 'rgb(252, 253, 251)', 'rgb(243, 247, 242)',
  ]);
  assert.deepEqual(await app.evaluate(({ BrowserWindow, nativeTheme }) => ({
    mode: nativeTheme.themeSource, background: BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase(),
  })), { mode: 'light', background: '#fcfdfb' });
  assert.equal(await page.locator('#cursor').textContent(), cursor);
  assert.match(await editor.textContent(), /second = "draft"/);

  await open('first.ts');
  assert.match(await editor.textContent(), /first = 42/);
  assert.equal(await editor.getByText('const', { exact: true }).evaluate(element => getComputedStyle(element).color),
    'rgb(102, 51, 140)');
  await editor.press('Control+z');
  assert.deepEqual(await editor.locator('.cm-line').allTextContents(), ['const first = 1;', '']);
  assert.equal(await fs.readFile(path.join(project, 'second.js'), 'utf8'), second);

  workbench = await workbench.restart();
  await waitForTheme(workbench.page, 'light', 'light');
  await workbench.selected('second.js').waitFor();
  assert.match(await workbench.editor.textContent(), /second = "draft"/);
});

test('System theme follows native color changes and a failed theme save rolls back the control',
  { timeout: 30_000 }, async t => {
  const { app, page, profile, open } = await openWorkbench(t, { 'entry.js': 'const ready = true;' });
  const theme = page.getByRole('combobox', { name: 'Theme' });
  const preference = path.join(profile, 'preferences.json');
  await open('entry.js');
  await waitForTheme(page, 'dark', 'dark');
  await fs.mkdir(preference);
  await theme.selectOption('light');
  await page.locator('#message[data-error="true"]').waitFor();
  await waitForTheme(page, 'dark', 'dark');
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark');

  await fs.rmdir(preference);
  await theme.selectOption('system');
  await page.locator('#message').getByText('Theme saved.', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const select = document.getElementById('theme-choice');
    return !select.disabled && select.value === 'system';
  });
  const native = await app.evaluate(({ nativeTheme }) => ({ theme: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }));
  assert.equal(native.theme, 'system');
  await waitForTheme(page, 'system', native.dark ? 'dark' : 'light');
  assert.deepEqual(JSON.parse(await fs.readFile(preference, 'utf8')), { theme: 'system' });

  const opposite = native.dark ? 'light' : 'dark';
  // Emit a native theme change within this Electron process without altering Windows settings.
  await app.evaluate(({ nativeTheme }, mode) => { nativeTheme.themeSource = mode; }, opposite);
  await waitForTheme(page, 'system', opposite);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase()),
    opposite === 'dark' ? '#101417' : '#fcfdfb');
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });
  await waitForTheme(page, 'system', native.dark ? 'dark' : 'light');
});

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
    'terminal-tree.cjs': terminalTree,
    'running.cjs': [
      'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
      '  { stdio: "ignore", detached: true, windowsHide: true });',
      'child.once("spawn", () => console.log("running " + process.pid + " " + child.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  });
  await workbench.open('renderer.cjs');
  await replaceEditor(workbench, 'console.log("renderer recovery");\n');
  await workbench.open('running.cjs');
  await workbench.editor.press('F5');
  const pattern = /running (\d+) (\d+)/;
  await workbench.output.getByText(pattern).waitFor();
  const running = pattern.exec(await workbench.output.textContent()).slice(1).map(Number);
  if (process.platform === 'win32') {
    await workbench.page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await workbench.page.getByRole('button', { name: 'New terminal', exact: true }).click();
    running.push(...await startTerminalTree(workbench.page));
  }
  const replacement = workbench.app.waitForEvent('window', { timeout: 10_000 });
  await workbench.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  const page = await replacement;
  await Promise.all(running.map(assertWindowsProcessStopped));
  page.setDefaultTimeout(8_000);
  const editor = page.getByRole('textbox', { name: 'Source editor' });
  await page.getByText('Recovered 1 unsaved file.', { exact: true }).waitFor();
  assert.equal(await page.locator('.terminal-surface').count(), 0);
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
    const grant = await window.cevra.authorizeRun(project.id, 1);
    const operations = [
      window.cevra.read(project.id, '../outside/secret.cjs'),
      window.cevra.save(project.id, 'junction/secret.cjs', 'changed', revision),
      window.cevra.start(project.id, 'junction/secret.cjs', revision, 1, grant),
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

test('hover shows a cross-file signature and updates from an unsaved export', { timeout: 30_000 }, async t => {
  const folder = 'lib (# % &)';
  const relative = path.join(folder, 'price.ts');
  const saved = '/** Saved signature. */\nexport function price(amount: number): string { return String(amount); }\n';
  const workbench = await openWorkbench(t, {
    'main.ts': 'import { price } from "@lib/price";\nconst total = price(12);\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@lib/*': ['./' + folder + '/*'] } } }),
    [relative]: saved,
  });
  const { page, open, editor, project, state } = workbench;
  const symbol = editor.getByText('price', { exact: true }).last();
  const signature = page.locator('.symbol-signature');
  await open('main.ts');
  await symbol.hover();
  await signature.getByText(/price\(amount: number\): string/).waitFor();
  await page.locator('.symbol-documentation').getByText('Saved signature.', { exact: true }).waitFor();
  await workbench.file(folder).click();
  await open('price.ts');
  await replaceEditor(workbench, '/** <img src=x> draft documentation. */\n' +
    'export function price(amount: bigint, currency: string): string { return currency + amount; }\n');

  await open('main.ts');
  await symbol.hover();
  await signature.getByText(/price\(amount: bigint, currency: string\): string/).waitFor();
  await page.locator('.symbol-documentation').getByText('<img src=x> draft documentation.', { exact: true }).waitFor();
  assert.equal(await page.locator('.symbol-info img').count(), 0);
  assert.equal(await fs.readFile(path.join(project, relative), 'utf8'), saved);
  assert.equal(await state.textContent(), 'Ready');
});

test('symbol inspection discards stale replies and leaves editing and saving available after a worker error',
  { timeout: 25_000 }, async t => {
  const workbench = await openWorkbench(t, { 'entry.js': 'const current = 1;\n' });
  const { app, page, editor, open, project } = workbench;
  await app.evaluate(({ ipcMain }) => {
    let requests = 0;
    ipcMain.removeHandler('cevra:quick-info');
    ipcMain.handle('cevra:quick-info', () => {
      requests++;
      if (requests === 1) {
        return new Promise(resolve => {
          ipcMain.releaseHeldSymbol = () => resolve({ from: 0, to: 5, signature: 'Stale signature', documentation: '' });
          ipcMain.waitForHeldSymbol?.();
        });
      }
      if (requests === 2) throw new Error('Test language service stopped.');
      return { from: 0, to: 5, signature: 'Current signature', documentation: '' };
    });
  });
  await open('entry.js');
  await page.evaluate(() => {
    window.sawStaleSymbol = false;
    new MutationObserver(() => {
      if (document.body.textContent.includes('Stale signature')) window.sawStaleSymbol = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await editor.press('Control+Alt+i');
  await app.evaluate(({ ipcMain }) => {
    if (ipcMain.releaseHeldSymbol) return;
    return new Promise(resolve => { ipcMain.waitForHeldSymbol = resolve; });
  });
  await replaceEditor(workbench, 'const current = 2;\n');
  await app.evaluate(({ ipcMain }) => ipcMain.releaseHeldSymbol());
  await editor.press('Control+Alt+i');
  await page.locator('#message').getByText('Test language service stopped.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.sawStaleSymbol), false);
  assert.equal(await page.locator('.symbol-info').count(), 0);
  await editor.press('Control+s');
  await page.locator('#message').getByText('Saved entry.js', { exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project, 'entry.js'), 'utf8'), 'const current = 2;\n');
  await page.getByRole('button', { name: 'Inspect symbol', exact: true }).click();
  await page.locator('.symbol-signature').getByText('Current signature', { exact: true }).waitFor();
  await editor.press('Escape');
  await page.locator('.symbol-info').waitFor({ state: 'detached' });
});

test('JavaScript autocomplete follows unsaved imports and supports keyboard selection and undo',
  { timeout: 30_000 }, async t => {
  const folder = 'lib (# % &)';
  const relative = path.join(folder, 'model.js');
  const saved = 'export const model = { diskOnly: 1 };\n';
  const entry = 'import { model } from "./' + folder + '/model.js";\nmodel';
  const workbench = await openWorkbench(t, { 'main.js': entry, [relative]: saved });
  const { page, editor, open, project } = workbench;
  const list = page.getByRole('listbox');
  const option = name => list.getByRole('option', { name });
  await workbench.file(folder).click();
  await open('model.js');
  await replaceEditor(workbench, 'export const model = { add(value) { return value; }, zebra: 1 };\n');

  await open('main.js');
  await editor.press('Control+End');
  await page.keyboard.type('.');
  await option(/add.*method/).waitFor();
  await option(/zebra.*property/).waitFor();
  assert.equal(await option(/diskOnly/).count(), 0);
  assert.equal(await option(/add.*method/).getAttribute('aria-selected'), 'true');
  // CodeMirror deliberately ignores completion keystrokes just after opening the list.
  await delay(100);
  await editor.press('ArrowDown');
  assert.equal(await option(/zebra.*property/).getAttribute('aria-selected'), 'true');
  await editor.press('Enter');
  await list.waitFor({ state: 'detached' });
  assert.deepEqual(await editor.locator('.cm-line').allTextContents(), (entry + '.zebra').split('\n'));
  await editor.press('Control+z');
  assert.deepEqual(await editor.locator('.cm-line').allTextContents(), (entry + '.').split('\n'));
  assert.equal(await fs.readFile(path.join(project, relative), 'utf8'), saved);
  assert.equal(await fs.readFile(path.join(project, 'main.js'), 'utf8'), entry);
});

test('TypeScript autocomplete preserves member syntax and suggests typed argument values', { timeout: 30_000 }, async t => {
  const entry = 'const data = { calculate() {}, "dash-name": 1 };\ndata.calOld;\ndata?.da;\n' +
    'function setMode(level: "basic" | "advanced") {}\nsetMode("ba");';
  const { page, editor, open } = await openWorkbench(t, { 'main.ts': entry });
  const list = page.getByRole('listbox');
  await open('main.ts');
  await editor.press('Control+Home');
  await editor.press('ArrowDown');
  await editor.press('End');
  for (let index = 0; index < 4; index++) await editor.press('ArrowLeft');
  await editor.press('Control+Space');
  await list.getByRole('option', { name: /calculate.*method/ }).waitFor();
  await delay(100);
  await editor.press('Enter');
  assert.equal((await editor.locator('.cm-line').allTextContents())[1], 'data.calculate;');

  await editor.press('ArrowDown');
  await editor.press('End');
  await editor.press('ArrowLeft');
  await editor.press('Control+Space');
  await list.getByRole('option', { name: /dash-name.*property/ }).waitFor();
  await delay(100);
  await editor.press('Enter');
  assert.equal((await editor.locator('.cm-line').allTextContents())[2], 'data?.["dash-name"];');

  await editor.press('Control+End');
  for (let index = 0; index < 3; index++) await editor.press('ArrowLeft');
  await editor.press('Control+Space');
  await list.getByRole('option', { name: /basic.*string/ }).waitFor();
  await delay(100);
  await editor.press('Enter');
  assert.equal((await editor.locator('.cm-line').allTextContents())[4], 'setMode("basic");');
});

test('autocomplete ignores late replies after typing or switching tabs and recovers after a service error',
  { timeout: 30_000 }, async t => {
  const workbench = await openWorkbench(t, { 'entry.js': 'const value = 1;\n', 'other.txt': 'other tab' });
  const { app, page, editor, open, project } = workbench;
  await app.evaluate(({ ipcMain }) => {
    let count = 0;
    const held = new Map();
    const waiters = new Map();
    ipcMain.waitForCompletion = id => held.has(id) ? Promise.resolve() : new Promise(resolve => waiters.set(id, resolve));
    ipcMain.releaseCompletion = id => held.get(id)();
    ipcMain.removeHandler('cevra:complete');
    ipcMain.handle('cevra:complete', (_event, _workspace, _file, position) => {
      const id = ++count;
      const suggestion = label => ({
        from: position, to: position, global: false,
        options: [{ label, kind: 'const', insert: label, from: position, to: position }],
      });
      if (id === 1 || id === 3) {
        return new Promise(resolve => {
          held.set(id, () => resolve(suggestion('staleOption')));
          waiters.get(id)?.();
        });
      }
      if (id === 4) throw new Error('Test completion service stopped.');
      return suggestion(id === 2 ? 'currentOption' : 'restartedOption');
    });
  });
  await open('entry.js');
  const list = page.getByRole('listbox');
  await page.evaluate(() => {
    window.sawStaleCompletion = false;
    new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes].some(node => node.textContent.includes('staleOption')))) {
        window.sawStaleCompletion = true;
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await editor.press('Control+End');
  await editor.press('Control+Space');
  await app.evaluate(({ ipcMain }) => ipcMain.waitForCompletion(1));
  await page.keyboard.type('x');
  await list.getByRole('option', { name: /currentOption/ }).waitFor();
  await app.evaluate(({ ipcMain }) => ipcMain.releaseCompletion(1));

  await editor.press('Escape');
  await editor.press('Control+Space');
  await app.evaluate(({ ipcMain }) => ipcMain.waitForCompletion(3));
  await open('other.txt');
  await open('entry.js');
  await app.evaluate(({ ipcMain }) => ipcMain.releaseCompletion(3));
  await editor.press('Control+Space');
  await page.locator('#message').getByText('Test completion service stopped.', { exact: true }).waitFor();
  assert.equal(await list.count(), 0);
  await editor.press('Control+s');
  await page.locator('#message').getByText('Saved entry.js', { exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project, 'entry.js'), 'utf8'), 'const value = 1;\nx');
  await editor.press('Control+Space');
  await list.getByRole('option', { name: /restartedOption/ }).waitFor();
  assert.equal(await page.evaluate(() => window.sawStaleCompletion), false);
});

test('signature help follows nested calls and shows documentation from unsaved imports', { timeout: 30_000 }, async t => {
  const folder = 'lib (# % &)';
  const relative = path.join(folder, 'pricing.js');
  const saved = '/**\n * @param {number} amount Numeric amount.\n * @param {string} unit Saved unit.\n */\n' +
    'export function price(amount, unit) { return amount + unit; }\n' +
    '/** @param {string} label Label to count. */\nexport function count(label) { return label.length; }\n';
  const entry = 'import { price, count } from "./' + folder + '/pricing.js";\nprice';
  const workbench = await openWorkbench(t, { 'main.js': entry, [relative]: saved });
  const { page, editor, open, project } = workbench;
  const tooltip = page.locator('.signature-help');
  const active = tooltip.locator('.signature-parameter[aria-current="true"]');
  const docs = tooltip.locator('.signature-documentation');
  await open('main.js');
  await editor.press('Control+End');
  await page.keyboard.type('(');
  await active.getByText('amount: number', { exact: true }).waitFor();
  await docs.getByText('Numeric amount.', { exact: true }).waitFor();
  assert.equal(await editor.getAttribute('aria-describedby'), 'cevra-signature-help');

  await page.keyboard.type('count(');
  await active.getByText('label: string', { exact: true }).waitFor();
  await docs.getByText('Label to count.', { exact: true }).waitFor();
  await page.keyboard.insertText('"abc"');
  await editor.press('ArrowRight');
  await page.keyboard.type(', ');
  await active.getByText('unit: string', { exact: true }).waitFor();
  await docs.getByText('Saved unit.', { exact: true }).waitFor();

  await workbench.file(folder).click();
  await open('pricing.js');
  await tooltip.waitFor({ state: 'detached' });
  await replaceEditor(workbench, saved.replaceAll('unit', 'currency')
    .replace('Saved currency.', '<img src=x> Draft currency.'));
  await open('main.js');
  await active.getByText('currency: string', { exact: true }).waitFor();
  await docs.getByText('<img src=x> Draft currency.', { exact: true }).waitFor();
  assert.equal(await tooltip.locator('img').count(), 0);
  assert.equal(await fs.readFile(path.join(project, relative), 'utf8'), saved);
  assert.equal(await fs.readFile(path.join(project, 'main.js'), 'utf8'), entry);
  await editor.press('End');
  await tooltip.waitFor({ state: 'detached' });
  assert.equal(await editor.getAttribute('aria-describedby'), null);
});

test('signature help selects the TypeScript overload and can be dismissed or requested with the keyboard',
  { timeout: 30_000 }, async t => {
  const text = 'function render(value: number, digits: number): string;\n' +
    'function render(value: string, suffix: string): string;\n' +
    'function render(value: unknown, other: unknown) { return String(value) + String(other); }\n' +
    'render(5, 2);\nrender("x", "");';
  const { page, editor, open } = await openWorkbench(t, { 'main.ts': text });
  const tooltip = page.locator('.signature-help');
  const active = tooltip.locator('.signature-parameter');
  await open('main.ts');
  await editor.press('Control+End');
  for (let index = 0; index < 4; index++) await editor.press('ArrowLeft');
  await active.getByText('suffix: string', { exact: true }).waitFor();
  await tooltip.getByText('Overload 2 of 2', { exact: true }).waitFor();
  await editor.press('Escape');
  await tooltip.waitFor({ state: 'detached' });
  await editor.press('Control+Shift+Space');
  await active.getByText('suffix: string', { exact: true }).waitFor();

  await editor.press('ArrowUp');
  await editor.press('End');
  for (let index = 0; index < 3; index++) await editor.press('ArrowLeft');
  await active.getByText('digits: number', { exact: true }).waitFor();
  await tooltip.getByText('Overload 1 of 2', { exact: true }).waitFor();
});

test('signature help discards replies after the caret moves and recovers from a failed request',
  { timeout: 30_000 }, async t => {
  const entry = 'price(12, 34)\nconst elsewhere = 0;\n';
  const { app, page, editor, open, project } = await openWorkbench(t, { 'main.js': entry });
  await app.evaluate(({ ipcMain }, heldPosition) => {
    ipcMain.removeHandler('cevra:signature-help');
    ipcMain.handle('cevra:signature-help', (_event, _workspace, _file, position) => {
      const result = parameter => ({ before: 'price(', parameter, after: ')', documentation: '', overloadCount: 1 });
      if (ipcMain.failSignature) throw new Error('Test signature service stopped.');
      if (position === heldPosition) {
        return new Promise(resolve => {
          ipcMain.releaseSignature = () => resolve(result('staleParameter'));
          ipcMain.waitForSignature?.();
        });
      }
      return result('currentParameter');
    });
  }, entry.indexOf(')'));
  await open('main.js');
  const tooltip = page.locator('.signature-help');
  await page.evaluate(() => {
    window.sawStaleSignature = false;
    new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes].some(node => node.textContent.includes('staleParameter')))) {
        window.sawStaleSignature = true;
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await editor.press('Control+Home');
  await editor.press('End');
  await editor.press('ArrowLeft');
  await app.evaluate(({ ipcMain }) => {
    if (ipcMain.releaseSignature) return;
    return new Promise(resolve => { ipcMain.waitForSignature = resolve; });
  });
  await editor.press('ArrowLeft');
  await tooltip.getByText('currentParameter', { exact: true }).waitFor();
  await app.evaluate(({ ipcMain }) => ipcMain.releaseSignature());
  await editor.press('Escape');
  await app.evaluate(({ ipcMain }) => { ipcMain.failSignature = true; });
  await editor.press('Control+Shift+Space');
  await page.locator('#message').getByText('Test signature service stopped.', { exact: true }).waitFor();
  assert.equal(await tooltip.count(), 0);
  assert.equal(await page.evaluate(() => window.sawStaleSignature), false);
  await app.evaluate(({ ipcMain }) => { ipcMain.failSignature = false; });
  await editor.press('Control+Shift+Space');
  await tooltip.getByText('currentParameter', { exact: true }).waitFor();

  await editor.press('Control+End');
  await tooltip.waitFor({ state: 'detached' });
  await page.keyboard.insertText('// edited after the failure\n');
  await editor.press('Control+s');
  await page.locator('#message').getByText('Saved main.js', { exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project, 'main.js'), 'utf8'), entry + '// edited after the failure\n');
});

test('Go to Definition selects a cross-file declaration, preserves drafts, and restores navigation history',
  { timeout: 30_000 }, async t => {
  const folder = 'lib (QA) & café [#%]';
  const relative = path.join(folder, 'totals.ts');
  const original = '\uFEFF// Windows source\r\nexport function total(value: number) { return value; }\r\n';
  const entry = 'import { total as calculate } from "./' + folder + '/totals";\nconst result = calculate(3);';
  const workbench = await openWorkbench(t, { 'main.ts': entry, [relative]: original });
  const { page, editor, open, selected, project } = workbench;
  const cursor = page.locator('#cursor');
  await open('main.ts');
  await replaceEditor(workbench, entry.replace('calculate(3)', 'calculate(42)'));
  await editor.press('Control+End');
  for (let index = 0; index < 6; index++) await editor.press('ArrowLeft');
  const origin = await cursor.textContent();
  await editor.press('F12');
  await selected('totals.ts').waitFor();
  await cursor.getByText('Ln 2, Col 17', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'total');

  await editor.press('Alt+ArrowLeft');
  await selected('main.ts').waitFor();
  await cursor.getByText(origin, { exact: true }).waitFor();
  assert.match(await editor.textContent(), /calculate\(42\)/);
  await editor.press('Alt+ArrowRight');
  await selected('totals.ts').waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'total');

  const draft = '// Local draft\n\nexport function total(value: number) { return value + 1; }\n';
  await replaceEditor(workbench, draft);
  await editor.press('Alt+ArrowLeft');
  await selected('main.ts').waitFor();
  await page.getByRole('button', { name: 'Go to Definition', exact: true }).click();
  await selected('totals.ts').waitFor();
  await cursor.getByText('Ln 3, Col 17', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'total');
  assert.match(await editor.textContent(), /value \+ 1/);
  assert.equal(await fs.readFile(path.join(project, relative), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(project, 'main.ts'), 'utf8'), entry);
});

test('Go to Definition offers an accessible choice when a symbol has several declarations',
  { timeout: 30_000 }, async t => {
  const entry = 'interface Shape { width: number }\ninterface Shape { height: number }\nlet value: Shape;';
  const { page, editor, open } = await openWorkbench(t, { 'main.ts': entry });
  const chooser = page.getByRole('dialog', { name: 'Choose a definition' });
  const cursor = page.locator('#cursor');
  await open('main.ts');
  await editor.press('Control+End');
  for (let index = 0; index < 3; index++) await editor.press('ArrowLeft');
  const origin = await cursor.textContent();
  await editor.press('Control+Alt+i');
  await page.locator('.symbol-info').getByText(/interface Shape/).waitFor();
  await editor.press('F12');
  await chooser.waitFor();
  await chooser.getByText('2 definitions found. Choose a declaration.', { exact: true }).waitFor();
  assert.equal(await chooser.getByRole('button', { name: /Shape main\.ts/ }).count(), 2);
  await page.keyboard.press('Escape');
  await chooser.waitFor({ state: 'hidden' });
  await cursor.getByText(origin, { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Go back', exact: true }).isDisabled(), true);

  await editor.press('F12');
  await chooser.waitFor();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await chooser.waitFor({ state: 'hidden' });
  await cursor.getByText('Ln 2, Col 11', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'Shape');
  await editor.press('Alt+ArrowLeft');
  await cursor.getByText(origin, { exact: true }).waitFor();
});

test('Go to Definition ignores a late reply after caret movement and verifies the destination disk revision',
  { timeout: 30_000 }, async t => {
  const initial = 'export function target() {}\n';
  const changed = '// external change\n' + initial;
  const { app, page, editor, open, selected, project } = await openWorkbench(t, {
    'main.js': 'import { target } from "./target.js";\ntarget();', 'target.js': initial,
  });
  function result(text, line) {
    return { limited: false, destinations: [{
      path: 'target.js', offset: text.indexOf('target'), length: 6, name: 'target', line, column: 17,
      revision: createHash('sha256').update(text).digest('hex'),
    }] };
  }
  await app.evaluate(({ ipcMain }, { oldResult, newResult }) => {
    let calls = 0;
    ipcMain.removeHandler('cevra:definition');
    ipcMain.handle('cevra:definition', () => {
      if (++calls === 1) {
        return new Promise(resolve => {
          ipcMain.releaseDefinition = () => resolve(oldResult);
          ipcMain.waitForDefinition?.();
        });
      }
      return calls === 2 ? oldResult : newResult;
    });
  }, { oldResult: result(initial, 1), newResult: result(changed, 2) });
  await open('main.js');
  await editor.press('Control+End');
  for (let index = 0; index < 5; index++) await editor.press('ArrowLeft');
  await editor.press('F12');
  await app.evaluate(({ ipcMain }) => {
    if (ipcMain.releaseDefinition) return;
    return new Promise(resolve => { ipcMain.waitForDefinition = resolve; });
  });
  await editor.press('ArrowRight');
  await editor.press('ArrowLeft');
  await app.evaluate(({ ipcMain }) => ipcMain.releaseDefinition());
  // Give the released IPC reply a turn while the caret is back at the original position.
  await delay(100);
  assert.equal(await selected('target.js').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Go back', exact: true }).isDisabled(), true);

  await fs.writeFile(path.join(project, 'target.js'), changed);
  await editor.press('F12');
  await page.locator('#message').getByText(/definition changed before it could be opened/).waitFor();
  assert.equal(await selected('target.js').count(), 0);
  await editor.press('F12');
  await selected('target.js').waitFor();
  await page.locator('#cursor').getByText('Ln 2, Col 17', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'target');
});

test('Find References groups closed-file and draft usages and refuses an outdated disk result',
  { timeout: 30_000 }, async t => {
  const folder = 'callers (QA) & café [#%]';
  const relative = path.join(folder, 'closed.js');
  const closed = '\uFEFFimport { total as closedCall } from "../cost.js";\r\nclosedCall(9);\r\n';
  const draftOnDisk = 'import { total as oldCall } from "./cost.js";\noldCall(2);\n';
  const workbench = await openWorkbench(t, {
    'cost.ts': 'export function total(value: number) { return value; }',
    'main.ts': 'import { total as quote } from "./cost.js";\nquote(3);',
    'draft.ts': draftOnDisk,
    'unrelated.ts': 'export function total() {}\ntotal();',
    [relative]: closed,
  });
  const { page, editor, open, selected, project } = workbench;
  const pane = page.getByRole('region', { name: 'Symbol references' });
  await open('draft.ts');
  await replaceEditor(workbench, '\n' + draftOnDisk.replaceAll('oldCall', 'draftCall'));
  await open('main.ts');
  await editor.press('Control+End');
  for (let index = 0; index < 6; index++) await editor.press('ArrowLeft');
  const origin = await page.locator('#cursor').textContent();
  await editor.press('Shift+F12');
  await pane.getByRole('status').getByText(/references in 4 files/).waitFor();
  assert.equal(await pane.getByRole('heading', { name: 'unrelated.ts', exact: true }).count(), 0);
  await pane.getByRole('heading', { name: relative, exact: true }).waitFor();
  await pane.getByRole('button', { name: /draft\.ts:3:1 draftCall\(2\)/ }).waitFor();
  assert.equal(await pane.getByRole('button', { name: /oldCall/ }).count(), 0);
  const usage = pane.getByRole('button', { name: /closed\.js:2:1 closedCall\(9\)/ });
  assert.equal(await selected('closed.js').count(), 0);
  await usage.click();
  await selected('closed.js').waitFor();
  await page.locator('#cursor').getByText('Ln 2, Col 1', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'closedCall');
  await editor.press('Alt+ArrowLeft');
  await selected('main.ts').waitFor();
  await page.locator('#cursor').getByText(origin, { exact: true }).waitFor();
  await fs.writeFile(path.join(project, relative), '// external change\n' + closed.slice(1));
  await usage.click();
  await pane.getByRole('status').getByText(/reference changed before it could be opened/).waitFor();
  assert.equal(await selected('closed.js').count(), 0);
  assert.equal(await fs.readFile(path.join(project, 'draft.ts'), 'utf8'), draftOnDisk);
});

test('Find References cancels searches and ignores replies after canceling or editing',
  { timeout: 30_000 }, async t => {
  const { app, page, editor, open } = await openWorkbench(t, { 'main.js': 'const value = 1;\nvalue;' });
  await app.evaluate(({ ipcMain }) => {
    let calls = 0;
    const held = new Map();
    const waiting = new Map();
    ipcMain.waitForReferences = id => held.has(id) ? Promise.resolve() : new Promise(resolve => waiting.set(id, resolve));
    ipcMain.releaseReferences = id => held.get(id)();
    ipcMain.removeHandler('cevra:references');
    ipcMain.handle('cevra:references', () => {
      const id = ++calls;
      const result = {
        count: 1, scope: '.', symbol: id <= 2 ? 'Old reference query' : 'Current reference query',
        files: [{ path: 'main.js', matches: [{ offset: 6, length: 5, line: 1, column: 7, preview: id <= 2 ? 'staleUsage' : 'currentUsage' }] }],
      };
      if (id > 2) return result;
      return new Promise(resolve => {
        held.set(id, () => resolve(result));
        waiting.get(id)?.();
      });
    });
  });
  await page.evaluate(() => {
    window.sawStaleReference = false;
    const results = document.getElementById('reference-results');
    new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes].some(node => node.textContent.includes('staleUsage')))) {
        window.sawStaleReference = true;
      }
    }).observe(results, { childList: true, subtree: true });
  });
  await open('main.js');
  await editor.press('Control+End');
  await editor.press('Shift+F12');
  await app.evaluate(({ ipcMain }) => ipcMain.waitForReferences(1));
  const pane = page.getByRole('region', { name: 'Symbol references' });
  await pane.getByRole('button', { name: 'Cancel', exact: true }).click();
  await pane.getByRole('status').getByText('Reference search canceled.', { exact: true }).waitFor();
  await app.evaluate(({ ipcMain }) => ipcMain.releaseReferences(1));

  await editor.press('Shift+F12');
  await app.evaluate(({ ipcMain }) => ipcMain.waitForReferences(2));
  await page.keyboard.insertText('\n// newer source');
  await pane.getByRole('status').getByText('Source changed. Run Find References again.', { exact: true }).waitFor();
  await app.evaluate(({ ipcMain }) => ipcMain.releaseReferences(2));
  await pane.getByRole('button', { name: 'Find References', exact: true }).click();
  await pane.getByRole('button', { name: /currentUsage/ }).waitFor();
  assert.equal(await page.evaluate(() => window.sawStaleReference), false);
});

test('Go to Symbol searches closed declarations, picks by keyboard, and reads unsaved symbols',
  { timeout: 30_000 }, async t => {
  const folder = 'packages (QA) & café [#%]';
  const relative = path.join(folder, 'client.ts');
  const initial = 'export function dispatch() {}\n';
  const workbench = await openWorkbench(t, {
    'first.ts': initial,
    [relative]: '\uFEFFexport class Client {\r\n  dispatch() { return 1; }\r\n}\r\n',
  });
  const { page, editor, open, selected, project } = workbench;
  const picker = page.getByRole('dialog', { name: 'Go to Symbol' });
  const query = picker.getByRole('combobox', { name: 'Search symbols' });
  await page.getByRole('button', { name: 'Go to Symbol', exact: true }).click();
  await query.fill('dispatch');
  await picker.getByRole('option', { name: /dispatch function first\.ts/ }).waitFor();
  const method = picker.getByRole('option', { name: /Client\.dispatch method .*client\.ts/ });
  await method.waitFor();
  await query.press('ArrowDown');
  assert.equal(await method.getAttribute('aria-selected'), 'true');
  await query.press('Enter');
  await picker.waitFor({ state: 'hidden' });
  await selected('client.ts').waitFor();
  await page.locator('#cursor').getByText('Ln 2, Col 3', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'dispatch');
  await page.getByRole('group', { name: 'Current file path' }).getByText(`${folder} › client.ts`, { exact: true }).waitFor();

  await open('first.ts');
  await replaceEditor(workbench, 'export type DraftDispatch = string;\n' + initial);
  await page.locator('#tabs').getByRole('button', { name: 'client.ts', exact: true }).click();
  await selected('client.ts').waitFor();
  const origin = await page.locator('#cursor').textContent();
  await editor.press('Control+t');
  await query.fill('DraftDispatch');
  await picker.getByRole('option', { name: /DraftDispatch type first\.ts/ }).waitFor();
  await query.press('Enter');
  await selected('first.ts').waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'DraftDispatch');
  assert.equal(await fs.readFile(path.join(project, 'first.ts'), 'utf8'), initial);
  await editor.press('Alt+ArrowLeft');
  await selected('client.ts').waitFor();
  await page.locator('#cursor').getByText(origin, { exact: true }).waitFor();
});

test('Go to Symbol ignores a superseded query and refuses a changed destination', { timeout: 30_000 }, async t => {
  const initial = 'export function target() {}\n';
  const { app, page, editor, open, selected, project } = await openWorkbench(t, {
    'main.js': 'const source = 1;\n', 'target.js': initial,
  });
  const target = {
    name: 'target', kind: 'function', path: 'target.js', offset: 16, length: 6, line: 1, column: 17,
    revision: createHash('sha256').update(initial).digest('hex'),
  };
  await app.evaluate(({ ipcMain }, item) => {
    ipcMain.removeHandler('cevra:symbols');
    ipcMain.handle('cevra:symbols', (_event, _workspace, query) => {
      if (query === 'target') return { items: [item] };
      return new Promise(resolve => {
        ipcMain.releaseSymbols = () => resolve({ items: [{ ...item, name: 'staleSymbol' }] });
        ipcMain.waitForSymbols?.();
      });
    });
  }, target);
  await open('main.js');
  await page.evaluate(() => {
    window.sawStaleSymbolResult = false;
    new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes].some(node => node.textContent.includes('staleSymbol')))) {
        window.sawStaleSymbolResult = true;
      }
    }).observe(document.getElementById('symbol-results'), { childList: true, subtree: true });
  });
  const picker = page.getByRole('dialog', { name: 'Go to Symbol' });
  const query = picker.getByRole('combobox', { name: 'Search symbols' });
  await editor.press('Control+t');
  await query.fill('old');
  await app.evaluate(({ ipcMain }) => {
    if (ipcMain.releaseSymbols) return;
    return new Promise(resolve => { ipcMain.waitForSymbols = resolve; });
  });
  await query.fill('target');
  await picker.getByRole('option', { name: /target function target\.js/ }).waitFor();
  await app.evaluate(({ ipcMain }) => ipcMain.releaseSymbols());
  assert.equal(await picker.getByRole('option', { name: /staleSymbol/ }).count(), 0);
  await fs.writeFile(path.join(project, 'target.js'), '// external change\n' + initial);
  await query.press('Enter');
  await page.locator('#message').getByText(/symbol changed before it could be opened/).waitFor();
  assert.equal(await selected('target.js').count(), 0);
  assert.equal(await page.evaluate(() => window.sawStaleSymbolResult), false);
});

test('the compact workbench gives the editor space and keeps layout controls and indentation usable',
  { timeout: 30_000 }, async t => {
  const folder = 'code (nested)';
  const name = 'entry.js';
  const content = 'function outer() {\n  if (true) {\n    return "room";\n  }\n}\nconsole.log(outer());\n';
  const workbench = await openWorkbench(t, { [path.join(folder, name)]: content });
  const { app, page, editor, open, file, output } = workbench;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(740, 560));
  await page.waitForFunction(() => window.innerWidth <= 740);
  await file(folder).click();
  await open(name);
  const viewport = page.locator('#editor');
  const dock = page.locator('#run-panel');
  assert.ok((await viewport.boundingBox()).height > 340);
  const sidebar = await page.locator('#workspace-sidebar').boundingBox();
  const searchToggle = await page.locator('#search-toggle').boundingBox();
  assert.ok(searchToggle.x + searchToggle.width <= sidebar.x + sidebar.width);
  await page.getByRole('button', { name: 'Show bottom panel', exact: true }).waitFor();
  await output.waitFor({ state: 'hidden' });
  await page.getByRole('group', { name: 'Current file path' }).getByText(`${folder} › ${name}`, { exact: true }).waitFor();
  assert.equal(await editor.locator('.cm-indent-guides').filter({ hasText: 'return' }).evaluate(element =>
    element.style.getPropertyValue('--guide-width')), '4ch');

  await editor.press('Control+Home');
  await editor.press('ArrowDown');
  await editor.press('Tab');
  assert.equal((await editor.locator('.cm-line').allTextContents())[1], '    if (true) {');
  await editor.press('Shift+Tab');
  assert.equal((await editor.locator('.cm-line').allTextContents())[1], '  if (true) {');
  await editor.press('Escape');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('#editor'))), false);
  const cursor = await page.locator('#cursor').textContent();
  const originalWidth = (await viewport.boundingBox()).width;
  await editor.press('Control+b');
  await page.getByRole('button', { name: 'Show Explorer', exact: true }).waitFor();
  await page.waitForFunction(width => document.getElementById('editor').getBoundingClientRect().width >= width + 150, originalWidth);
  assert.equal(await page.locator('#cursor').textContent(), cursor);
  await editor.press('Control+Shift+f');
  const search = page.getByRole('searchbox', { name: 'Search project' });
  await search.waitFor();
  await search.press('Escape');

  await editor.press('Control+j');
  await output.waitFor();
  const handle = page.getByRole('separator', { name: 'Resize bottom panel' });
  const originalHeight = (await dock.boundingBox()).height;
  await handle.press('ArrowUp');
  assert.ok((await dock.boundingBox()).height >= originalHeight + 14);
  const beforeDrag = (await dock.boundingBox()).height;
  const bar = await handle.boundingBox();
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2 - 22);
  await page.mouse.up();
  assert.ok((await dock.boundingBox()).height >= beforeDrag + 18);
  await editor.press('Control+j');
  await output.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Flightpath', exact: true }).click();
  await page.getByRole('button', { name: 'Enable local history', exact: true }).waitFor();
  const dockBounds = await dock.boundingBox();
  const hidePanel = await page.getByRole('button', { name: 'Hide bottom panel', exact: true }).boundingBox();
  assert.ok(hidePanel.x + hidePanel.width <= dockBounds.x + dockBounds.width);
  await editor.press('F5');
  await output.getByText('room', { exact: true }).waitFor();
});
