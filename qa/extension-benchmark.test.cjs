const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { createExtensionRegistry } = require('../src/extensions/registry.cjs');
const { openWorkbench } = require('./desktop-workbench.cjs');
const { archive, manifest } = require('./extension-fixtures.cjs');
const { commandPackages, desktopHosts, manager, seedExtensions } = require('./extension-scenarios.cjs');
const { temporaryFolder } = require('./temp.cjs');

const root = path.resolve(__dirname, '..');
const baselineCommit = 'f2048ffda5a02e21acfe8d6d39632070c5557961';
const original = 'module.exports = 42;\n';
const typed = 'module.exports = 42;2\n';
const execute = promisify(execFile);

async function git(cwd, ...args) {
  return (await execute('git', args, { cwd, windowsHide: true })).stdout.trim();
}

async function writeFixture(project) {
  await fs.writeFile(path.join(project, 'edit.cjs'), original);
  await fs.writeFile(path.join(project, 'answer.test.cjs'), [
    'const assert = require("node:assert/strict");',
    'require("node:test")("answer", () => assert.equal(require("./edit.cjs"), 42));', '',
  ].join('\n'));
  for (let group = 0; group < 6; group++) {
    const folder = path.join(project, 'feature-' + group);
    await fs.mkdir(folder);
    for (let file = 0; file < 8; file++) {
      await fs.writeFile(path.join(folder, 'source-' + file + '.cjs'), 'module.exports = ' + (group * 8 + file) + ';\n');
    }
  }
}

async function paint(workbench) {
  const { page, editor } = workbench;
  await editor.press('Control+Home');
  await editor.press('End');
  await page.evaluate(expected => {
    const content = document.querySelector('.cm-content');
    window.benchmarkPaint = undefined;
    content.addEventListener('keydown', () => {
      const started = performance.now();
      const observer = new MutationObserver(() => {
        if (content.firstElementChild?.textContent !== expected) return;
        observer.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => { window.benchmarkPaint = performance.now() - started; }));
      });
      observer.observe(content, { childList: true, characterData: true, subtree: true });
    }, { once: true });
  }, typed.trimEnd());
  await editor.press('2');
  await page.waitForFunction(() => Number.isFinite(window.benchmarkPaint));
  return page.evaluate(() => window.benchmarkPaint);
}

async function zero(t, projectPath, appRoot) {
  const workbench = await openWorkbench(t, {}, undefined, { projectPath, appRoot });
  const { app, page, state, open, openMs } = workbench;
  const runtime = await app.evaluate(() => ({ node: process.versions.node, electron: process.versions.electron }));
  if (appRoot === root) {
    assert.deepEqual(await page.evaluate(async () => (await window.cevra.extensionRuntime()).catalog), []);
  }
  await open('edit.cjs');
  const testStart = performance.now();
  await page.getByRole('button', { name: 'Run tests', exact: true }).click();
  await state.getByText(/^Passed/).waitFor();
  const testMs = performance.now() - testStart;
  const paintMs = await paint(workbench);
  await page.locator('#draft-status[data-state="saved"]').waitFor();
  const recoveryStart = performance.now();
  const restarted = await workbench.restart({ crash: true });
  await restarted.selected('edit.cjs').waitFor();
  assert.deepEqual(await restarted.editor.locator('.cm-line').allTextContents(), typed.split('\n'));
  const recoveryMs = performance.now() - recoveryStart;
  assert.equal(await fs.readFile(path.join(projectPath, 'edit.cjs'), 'utf8'), original);
  return { runtime, metrics: { startupMs: openMs, paintMs, testMs, recoveryMs } };
}

function inertPackages() {
  return Array.from({ length: 50 }, (_, index) => {
    const data = { ...manifest(), id: 'org.cevra.qa.inert-' + index, displayName: 'Inert ' + index };
    return { manifest: data, bytes: archive(data) };
  });
}

async function copyRegistry(source, profile) {
  const directory = path.join(profile, 'extensions');
  await fs.mkdir(directory);
  await fs.copyFile(path.join(source, 'extensions', 'registry.json'), path.join(directory, 'registry.json'));
}

async function inert(t, projectPath, seeded) {
  const registry = createExtensionRegistry(seeded);
  const catalogStart = performance.now();
  const rows = await registry.list();
  const catalogMs = performance.now() - catalogStart;
  assert.equal(rows.length, 50);
  assert.ok(rows.every(row => row.enabled && row.executable === false && row.state === 'enabled'));
  const { page, openMs } = await openWorkbench(t, {}, (_project, profile) => copyRegistry(seeded, profile), { projectPath });
  const contributionStart = performance.now();
  const contributions = await page.evaluate(async () => (await window.cevra.extensionContributions()).packages);
  const contributionsMs = performance.now() - contributionStart;
  assert.equal(contributions.length, 50);
  assert.ok(contributions.every(item => item.snippets.length === 1 && item.palettes.length === 0));
  return { catalogMs, startupMs: openMs, contributionsMs };
}

async function active(t, projectPath, seeded, fixtures) {
  const workbench = await openWorkbench(t, {}, (_project, profile) => copyRegistry(seeded, profile), { projectPath });
  const { app, page, open } = workbench;
  const ui = manager(page);
  await ui.open();
  const activationMs = [];
  for (const fixture of fixtures) {
    const row = ui.row(fixture);
    const started = performance.now();
    await ui.button('Review Permissions', row).click();
    await row.getByText('Active for this session', { exact: true }).waitFor();
    await ui.status.getByText('Permissions granted for this session.', { exact: true }).waitFor();
    activationMs.push(performance.now() - started);
  }
  const hosts = await desktopHosts(app);
  const workers = hosts.filter(item => item.worker);
  const launchers = hosts.filter(item => !item.worker);
  assert.equal(workers.length, 5);
  assert.equal(launchers.length, 5);
  assert.ok(hosts.every(item => Number.isFinite(item.workingSet) && item.workingSet > 0));
  const mib = processes => processes.reduce((sum, item) => sum + item.workingSet, 0) / 1024 ** 2;
  await ui.button('Close').click();
  await open('edit.cjs');
  const paintMs = await paint(workbench);
  await page.locator('#draft-status[data-state="saved"]').waitFor();
  await ui.open();
  const started = performance.now();
  await ui.button('Run Say hello', ui.row(fixtures.at(-1))).click();
  await ui.status.getByText('Command completed.', { exact: true }).waitFor();
  const commandMs = performance.now() - started;
  return { activationMs, paintMs, commandMs, workerWorkingSetMiB: mib(workers), launcherWorkingSetMiB: mib(launchers) };
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const round = value => Math.round(value * 100) / 100;
  const p50 = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { p50: round(p50), p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]) };
}

function summarize(samples) {
  return Object.fromEntries(Object.keys(samples[0]).map(key => [key, stats(samples.flatMap(sample => sample[key]))]));
}

test('Phase 4 matched Windows benchmark', { timeout: 900_000 }, async t => {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  const baseline = await fs.realpath(path.resolve(process.env.CEVRA_G9_BASELINE ?? ''));
  assert.equal(await git(baseline, 'rev-parse', 'HEAD'), baselineCommit, 'Set CEVRA_G9_BASELINE to the built Phase 3 checkout.');
  assert.equal(await git(baseline, 'status', '--porcelain', '--untracked-files=no'), '', 'Build from a clean Phase 3 checkout.');
  const lock = async directory => (await fs.readFile(path.join(directory, 'package-lock.json'), 'utf8')).replaceAll('\r\n', '\n');
  assert.ok(await lock(root) === await lock(baseline), 'Phase 3 and Phase 4 must use the same dependency lockfile.');
  const count = Number(process.env.CEVRA_G9_SAMPLES ?? 20);
  const activeCount = Number(process.env.CEVRA_G9_ACTIVE_SAMPLES ?? 5);
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 30, 'Use 1–30 paired and inert samples.');
  assert.ok(Number.isInteger(activeCount) && activeCount >= 1 && activeCount <= 20, 'Use 1–20 active samples.');
  const project = await temporaryFolder(t, 'cevra-g9-workspace-');
  await writeFixture(project);
  const inertSeed = await temporaryFolder(t, 'cevra-g9-inert-');
  await seedExtensions(inertSeed, inertPackages());
  const activeSeed = await temporaryFolder(t, 'cevra-g9-active-');
  const activeFixtures = await commandPackages(5);
  await seedExtensions(activeSeed, activeFixtures);

  const candidates = { phase3: baseline, phase4: root };
  const runtimes = {};
  const pairs = [];
  const inertSamples = [];
  const activeSamples = [];
  const benchmark = { commit: await git(root, 'rev-parse', 'HEAD'), dirty: Boolean(await git(root, 'status', '--porcelain')) };
  for (let round = 0; round <= count; round++) {
    const pair = {};
    const order = round % 2 ? ['phase4', 'phase3'] : ['phase3', 'phase4'];
    for (const name of order) {
      await t.test(`pair ${round} ${name}`, async t => {
        const result = await zero(t, project, candidates[name]);
        runtimes[name] = result.runtime;
        pair[name] = result.metrics;
      });
      assert.ok(pair[name], 'Each paired sample must complete.');
    }
    if (round) pairs.push({ order, ...pair });
  }
  assert.deepEqual(runtimes.phase3, runtimes.phase4);

  for (let round = 0; round <= count; round++) {
    await t.test(`50 inert packages ${round}`, async t => {
      const metrics = await inert(t, project, inertSeed);
      if (round) inertSamples.push(metrics);
    });
  }
  for (let round = 0; round <= activeCount; round++) {
    await t.test(`five active hosts ${round}`, async t => {
      const metrics = await active(t, project, activeSeed, activeFixtures);
      if (round) activeSamples.push(metrics);
    });
  }
  assert.equal(inertSamples.length, count);
  assert.equal(activeSamples.length, activeCount);
  const report = {
    schemaVersion: 1, phase: 4, gate: 'G9', recordedAt: new Date().toISOString(),
    baselineCommit, ...benchmark,
    machine: {
      os: os.release(), arch: process.arch, cpu: os.cpus()[0].model.trim(), logicalProcessors: os.cpus().length,
      memoryMiB: Math.round(os.totalmem() / 1024 ** 2), node: process.versions.node, electronRuntime: runtimes.phase4,
    },
    sampling: { pairedSamples: count, inertSamples: count, activeSamples: activeCount, warmupsPerScenario: 1 },
    summary: {
      phase3: summarize(pairs.map(pair => pair.phase3)),
      phase4Zero: summarize(pairs.map(pair => pair.phase4)),
      phase4Inert50: summarize(inertSamples),
      phase4Active5: summarize(activeSamples),
    },
    raw: { pairs, inertSamples, activeSamples },
  };
  await fs.writeFile(path.join(root, 'dist', 'phase4-g9-benchmark.json'), JSON.stringify(report, null, 2) + '\n');
  t.diagnostic('PHASE4_G9_BENCHMARK ' + JSON.stringify(report.summary));
});
