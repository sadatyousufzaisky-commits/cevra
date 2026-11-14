const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { openWorkbench } = require('./desktop-workbench.cjs');
const { temporaryFolder } = require('./temp.cjs');

const root = path.resolve(__dirname, '..');
const baselineCommit = '4960ef251237583f9ee7a21e067f949dd2f6d4b0';
const edit = 'const invoice = 42;\n';
const mockReply = 'This is an offline mock response.';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();

async function writeFixture(project) {
  await fs.writeFile(path.join(project, 'invoice.js'), edit);
  for (let group = 0; group < 6; group++) {
    const folder = path.join(project, 'nested feature ' + group);
    await fs.mkdir(folder);
    for (let file = 0; file < 8; file++) {
      await fs.writeFile(path.join(folder, 'source-' + file + '.js'), 'export const value = ' + (group * 8 + file) + ';\n');
    }
  }
}

async function paint({ page, editor }) {
  await editor.press('Control+End');
  await editor.press('ArrowUp');
  await editor.press('End');
  await page.evaluate(() => {
    const content = document.querySelector('.cm-content');
    content.addEventListener('keydown', () => {
      const start = performance.now();
      const observer = new MutationObserver(() => {
        if (!content.textContent.includes('42;2')) return;
        observer.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => { window.benchmarkEditMs = performance.now() - start; }));
      });
      observer.observe(content, { childList: true, characterData: true, subtree: true });
    }, { once: true });
  });
  await editor.press('2');
  await page.waitForFunction(() => Number.isFinite(window.benchmarkEditMs));
  return page.evaluate(() => window.benchmarkEditMs);
}

async function processMetrics(app) {
  return app.evaluate(({ app }) => app.getAppMetrics().reduce((result, process) => ({
    workingSetMiB: result.workingSetMiB + process.memory.workingSetSize / 1024,
    cpuSeconds: result.cpuSeconds + process.cpu.cumulativeCPUUsage,
  }), { workingSetMiB: 0, cpuSeconds: 0 }));
}

async function sample(t, projectPath, appRoot, enabled) {
  const workbench = await openWorkbench(t, {}, undefined, { appRoot, projectPath,
    args: enabled ? ['--enable-intelligence'] : [] });
  const { app, page, openMs, editor } = workbench;
  const runtime = await app.evaluate(() => ({ node: process.versions.node, electron: process.versions.electron }));
  const intelligence = page.getByRole('button', { name: 'Intelligence', exact: true });
  assert.equal(await intelligence.count(), enabled ? 1 : 0);
  await workbench.open('invoice.js');
  const editorPaintMs = await paint(workbench);
  await page.locator('#draft-status[data-state="saved"]').waitFor();
  assert.match(await editor.textContent(), /42;2/);
  assert.equal(await fs.readFile(path.join(projectPath, 'invoice.js'), 'utf8'), edit);
  const metrics = { startupMs: openMs, editorPaintMs, ...await processMetrics(app) };
  if (enabled) {
    const opened = app.waitForEvent('window');
    const start = performance.now();
    await intelligence.press('Enter');
    const panel = await opened;
    await panel.locator('#status').getByText('Ready.', { exact: true }).waitFor();
    metrics.panelOpenMs = performance.now() - start;
    await panel.getByLabel('Prompt', { exact: true }).fill('Explain the synthetic benchmark.');
    await panel.evaluate(() => {
      const send = document.getElementById('send');
      const output = document.getElementById('response');
      send.addEventListener('click', () => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (!output.textContent) return;
          observer.disconnect();
          requestAnimationFrame(() => { window.benchmarkFirstTextMs = performance.now() - start; });
        });
        observer.observe(output, { childList: true });
      }, { once: true });
    });
    await panel.getByRole('button', { name: 'Send', exact: true }).press('Enter');
    await panel.locator('#status').getByText('Response complete.', { exact: true }).waitFor();
    assert.equal(await panel.locator('#response').textContent(), mockReply);
    metrics.mockFirstTextMs = await panel.evaluate(() => window.benchmarkFirstTextMs);
    assert.ok(Number.isFinite(metrics.mockFirstTextMs));
    metrics.mockFirstTextLessDelayMs = Math.max(0, metrics.mockFirstTextMs - 120);
    metrics.panelWorkingSetMiB = (await processMetrics(app)).workingSetMiB;
  }
  assert.ok(Object.values(metrics).every(Number.isFinite));
  return { runtime, metrics };
}

function summarize(samples) {
  return Object.fromEntries(Object.keys(samples[0]).map(key => {
    const values = samples.map(sample => sample[key]).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const p50 = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    return [key, { p50: +p50.toFixed(2), p95: +values[Math.ceil(values.length * 0.95) - 1].toFixed(2) }];
  }));
}

test('Windows compares Phase 4 to Phase 5 with Intelligence off and enabled', { timeout: 360_000 }, async t => {
  assert.equal(process.platform + '-' + process.arch, 'win32-x64');
  assert.ok(process.env.CEVRA_PHASE5_BASELINE, 'Set CEVRA_PHASE5_BASELINE to the built Phase 4 worktree.');
  const baseline = await fs.realpath(process.env.CEVRA_PHASE5_BASELINE);
  assert.equal(git(baseline, 'rev-parse', 'HEAD'), baselineCommit);
  assert.equal(git(baseline, 'status', '--porcelain'), '');
  const lockfile = async folder => (await fs.readFile(path.join(folder, 'package-lock.json'), 'utf8')).replaceAll('\r\n', '\n');
  assert.ok(await lockfile(baseline) === await lockfile(root), 'The baseline and current build must use the same dependency lockfile.');
  const count = Number(process.env.CEVRA_PHASE5_SAMPLES ?? '20');
  assert.ok(Number.isInteger(count) && count > 0 && count <= 30);
  const projectPath = await temporaryFolder(t, 'cevra-phase5-benchmark-');
  await writeFixture(projectPath);
  const modes = ['phase4', 'phase5Off', 'phase5Enabled'];
  const samples = Object.fromEntries(modes.map(mode => [mode, []]));
  const order = [];
  let runtime;
  for (let index = -1; index < count; index++) {
    const offset = Math.max(index, 0) % modes.length;
    const row = [...modes.slice(offset), ...modes.slice(0, offset)];
    if (index >= 0) order.push(row);
    for (const mode of row) {
      await t.test(`${index < 0 ? 'Warm-up' : index + 1} ${mode}`, async child => {
        const result = await sample(child, projectPath, mode === 'phase4' ? baseline : root, mode === 'phase5Enabled');
        runtime ??= result.runtime;
        assert.deepEqual(result.runtime, runtime);
        if (index >= 0) samples[mode].push(result.metrics);
      });
    }
  }
  assert.ok(modes.every(mode => samples[mode].length === count));
  const result = {
    schemaVersion: 1, baselineCommit, implementationCommit: git(root, 'rev-parse', 'HEAD'),
    platform: os.platform(), arch: os.arch(), osRelease: os.release(), cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length, ramMiB: Math.round(os.totalmem() / 1024 / 1024), node: process.version, runtime,
    fixtureFiles: 49, measuredPerMode: count, warmupsPerMode: 1, order, samples,
    summaries: Object.fromEntries(modes.map(mode => [mode, summarize(samples[mode])])),
  };
  await fs.writeFile(path.join(root, 'dist', 'phase5-g9-benchmark.json'), JSON.stringify(result, null, 2) + '\n');
  t.diagnostic(JSON.stringify(result.summaries));
});
