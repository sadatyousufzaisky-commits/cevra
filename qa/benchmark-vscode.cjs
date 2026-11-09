const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { _electron } = require('playwright');

async function ensureIsolatedVscode(executablePath) {
  const installation = path.dirname(executablePath);
  const portableData = await fs.stat(path.join(installation, 'data')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (portableData) throw new Error('Use a VS Code executable that allows an isolated profile.');
}

async function sampleVscode({ executablePath, root, profile, needle, faultName }) {
  const user = path.join(profile, 'User');
  await fs.mkdir(user, { recursive: true });
  await fs.writeFile(path.join(user, 'settings.json'), JSON.stringify({
    'files.simpleDialog.enable': true,
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.tips.enabled': false,
    'debug.saveBeforeStart': 'none',
    launch: {
      version: '0.2.0',
      configurations: [{
        name: 'Benchmark Node', type: 'node', request: 'launch',
        cwd: root, program: path.join(root, 'main.cjs'), runtimeExecutable: process.execPath,
        console: 'internalConsole', internalConsoleOptions: 'openOnSessionStart',
      }],
    },
  }));
  const env = { ...process.env };
  delete env.VSCODE_PORTABLE;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath,
    args: ['--user-data-dir=' + profile, '--extensions-dir=' + path.join(profile, 'extensions'),
      '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window'],
    env,
    chromiumSandbox: true,
    timeout: 20_000,
  });
  try {
    const page = await app.firstWindow({ timeout: 15_000 });
    const version = await app.evaluate(({ app }) => app.getVersion());
    page.setDefaultTimeout(12_000);
    const keys = key => page.keyboard.press(key);
    const measure = async action => {
      const start = performance.now();
      await action();
      return performance.now() - start;
    };
    const lines = page.locator('.monaco-editor:visible .view-lines:visible').first();
    const selection = page.locator('.statusbar');
    const position = text => selection.getByText(text, { exact: true }).waitFor();
    await page.locator('.monaco-workbench').waitFor();
    await keys('Control+k');
    await keys('Control+o');
    const picker = page.locator('.quick-input-widget:visible');
    const folder = picker.getByRole('textbox', { name: /Folder path/ });
    await folder.fill(root + path.sep);
    await picker.getByRole('option', { name: 'group-0', exact: true }).waitFor();
    const editFile = page.locator('.explorer-folders-view').getByText('edit.ts', { exact: true });
    const openMs = await measure(async () => {
      await picker.getByRole('button', { name: 'OK', exact: true }).click();
      await editFile.waitFor();
    });
    const firstLine = lines.getByText(/const.*benchmark.*42/);
    const openFileMs = await measure(async () => {
      await editFile.click();
      await firstLine.waitFor();
    });
    await firstLine.click();
    await keys('Control+Home');
    await keys('End');
    await keys('ArrowLeft');
    await lines.evaluate(node => {
      window.editPaintMs = undefined;
      document.addEventListener('keydown', () => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (!node.textContent.includes('422;')) return;
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => { window.editPaintMs = performance.now() - start; }));
        });
        observer.observe(node, { childList: true, characterData: true, subtree: true });
      }, { capture: true, once: true });
    });
    await keys('2');
    await page.waitForFunction(() => Number.isFinite(window.editPaintMs));
    const editPaintMs = await page.evaluate(() => window.editPaintMs);

    await keys('Control+Shift+m');
    await keys('Control+1');
    await keys('Control+a');
    const syntaxIssue = page.getByText(/Expression expected\./).last();
    await page.keyboard.insertText('const benchmark = ;\n');
    await syntaxIssue.waitFor();
    await keys('Control+1');
    await keys('Control+a');
    await page.keyboard.insertText('const benchmark = 422;\n');
    await lines.getByText(/const.*benchmark.*422/).waitFor();
    await syntaxIssue.waitFor({ state: 'hidden' });
    await keys('Control+a');
    const diagnosticsMs = await measure(async () => {
      await page.keyboard.insertText('const benchmark = ;\n');
      await syntaxIssue.waitFor();
    });
    await syntaxIssue.click();
    await selection.getByText(/^Ln 1, Col (?:19|20 \(1 selected\))$/).waitFor();

    await keys('Control+Shift+f');
    const query = page.getByRole('textbox', { name: /^Search: Type Search Term/ });
    const match = page.locator('.search-view .monaco-list').getByText(needle, { exact: true }).last();
    const searchMs = await measure(async () => {
      await query.fill(needle);
      await match.waitFor();
    });
    await match.click();
    await position('Ln 51, Col 36 (22 selected)');

    const output = page.getByRole('tree', { name: 'Debug Console' });
    const runToFailureMs = await measure(async () => {
      await keys('Control+F5');
      await output.getByRole('treeitem', { name: /Process exited with code 1/ }).waitFor();
    });
    const destination = output.locator('a').filter({ hasText: encodeURIComponent(faultName) + ':3:9' });
    await destination.waitFor({ state: 'attached' });
    const runtimeJumpMs = await measure(async () => {
      await destination.dispatchEvent('click', { ctrlKey: true, bubbles: true, button: 0 });
      await position('Ln 3, Col 9');
    });
    await lines.getByText(/throw.*new.*Error/).waitFor();
    return { version, timings: { openMs, openFileMs, editPaintMs, diagnosticsMs, searchMs, runToFailureMs, runtimeJumpMs } };
  } finally {
    await app.close();
  }
}

module.exports = { ensureIsolatedVscode, sampleVscode };
