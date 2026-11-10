const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
  assert.fail('Windows process ' + pid + ' was still running after cleanup.');
}

async function openWorkbench(t, files, prepare) {
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
  await prepare?.(project);

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
  const started = performance.now();
  const result = await launch();
  await result.page.locator('#open-folder').click();
  await result.page.getByRole('heading', { name: 'Choose a file to edit.' }).waitFor().catch(async error => {
    throw new Error('Could not open the fixture. ' + await result.page.locator('#message').textContent(), { cause: error });
  });
  return { ...result, openMs: Math.round(performance.now() - started) };
}

async function replaceEditor(workbench, text) {
  await workbench.editor.press('Control+a');
  await workbench.page.keyboard.insertText(text);
  await workbench.page.locator('#draft-status[data-state="saved"]').waitFor();
}

module.exports = { assertWindowsProcessStopped, openWorkbench, replaceEditor };
