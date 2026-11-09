const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { _electron } = require('playwright');
const { temporaryFolder } = require('./temp.cjs');

const repo = path.resolve(__dirname, '..');
const needle = 'CEVRA_BENCHMARK_NEEDLE';
const faultFolder = 'nested (QA) & café [#%]';
const faultName = 'fault # %.cjs';
const featureCount = 160;

async function writeFixture(root) {
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, faultFolder));
  await fs.writeFile(path.join(root, 'edit.ts'), 'const benchmark = 42;\n');
  await fs.writeFile(path.join(root, 'main.cjs'), 'require(' + JSON.stringify('./' + faultFolder + '/' + faultName) + ')();\n');
  await fs.writeFile(path.join(root, faultFolder, faultName),
    'module.exports = function fail() {\n  const message = "benchmark runtime failure";\n  throw new Error(message);\n};\n');
  for (let group = 0; group < 8; group++) {
    const folder = path.join(root, 'group-' + group);
    await fs.mkdir(folder);
    await Promise.all(Array.from({ length: featureCount / 8 }, (_, index) => {
      const feature = group * (featureCount / 8) + index;
      const lines = Array.from({ length: 50 }, (_, line) =>
        'export const item' + line + ' = ' + (feature + line) + ';');
      if (feature === 79) lines.push('export const ' + needle + ' = 1;');
      return fs.writeFile(path.join(folder, 'feature-' + String(feature).padStart(3, '0') + '.ts'), lines.join('\n') + '\n');
    }));
  }
}

async function sample(root, profile) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [repo, '--user-data-dir=' + profile],
    cwd: repo,
    env,
    chromiumSandbox: true,
    timeout: 20_000,
  });
  try {
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, root);
    const page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    const editor = page.getByRole('textbox', { name: 'Source editor' });
    const tree = page.getByRole('navigation', { name: 'Project files' });
    const open = name => tree.getByRole('button', { name, exact: true }).click();
    const cursor = position => page.locator('#cursor').getByText(position, { exact: true }).waitFor();
    const measure = async action => {
      const start = performance.now();
      await action();
      return performance.now() - start;
    };
    const openFolder = page.locator('#open-folder');
    await page.waitForFunction(() => !document.getElementById('open-folder').disabled);
    const openMs = await measure(async () => {
      await openFolder.click();
      await tree.getByRole('button', { name: 'main.cjs', exact: true }).waitFor();
    });
    const openFileMs = await measure(async () => {
      await open('edit.ts');
      await editor.locator('.cm-line').filter({ hasText: 'const benchmark = 42;' }).waitFor();
    });
    await editor.press('Control+Home');
    await editor.press('End');
    await editor.press('ArrowLeft');
    await page.evaluate(() => {
      const content = document.querySelector('.cm-content');
      window.editPaintMs = undefined;
      content.addEventListener('keydown', () => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (!content.textContent.includes('422;')) return;
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => { window.editPaintMs = performance.now() - start; }));
        });
        observer.observe(content, { childList: true, characterData: true, subtree: true });
      }, { once: true });
    });
    await editor.press('2');
    await page.waitForFunction(() => Number.isFinite(window.editPaintMs));
    const editPaintMs = await page.evaluate(() => window.editPaintMs);

    await editor.press('Control+Shift+m');
    const syntax = page.getByRole('region', { name: 'Syntax problems' });
    await page.locator('#problems-status').getByText('No syntax problems.', { exact: true }).waitFor();
    await editor.press('Control+a');
    const syntaxIssue = syntax.getByRole('button', { name: /Expression expected/ });
    const diagnosticsMs = await measure(async () => {
      await page.keyboard.insertText('const benchmark = ;\n');
      await syntaxIssue.waitFor();
    });
    await syntaxIssue.click();
    await cursor('Ln 1, Col 19');
    assert.equal(await page.evaluate(() => window.getSelection().toString()), ';');
    await editor.press('Control+z');

    await editor.press('Control+Shift+f');
    const query = page.getByRole('searchbox', { name: 'Search project' });
    const match = page.locator('#search-results').getByRole('button', { name: /feature-079\.ts:51:14/ });
    const searchMs = await measure(async () => {
      await query.fill(needle);
      await match.waitFor();
    });
    await match.click();
    await cursor('Ln 51, Col 14');
    assert.equal(await page.evaluate(() => window.getSelection().toString()), needle);
    await page.getByRole('button', { name: 'Search project', exact: true }).click();

    await open('main.cjs');
    const runToFailureMs = await measure(async () => {
      await editor.press('F5');
      await page.locator('#run-state').getByText(/^Failed/).waitFor();
    });
    const destination = page.getByRole('button', { name: path.join(faultFolder, faultName) + ':3:9', exact: true });
    const runtimeJumpMs = await measure(async () => {
      await destination.click();
      await cursor('Ln 3, Col 9');
    });
    assert.equal(await page.locator('#tabs [aria-current=true]').textContent(), faultName);
    return { openMs, openFileMs, editPaintMs, diagnosticsMs, searchMs, runToFailureMs, runtimeJumpMs };
  } finally {
    await app.close();
  }
}

function summarize(samples) {
  return Object.fromEntries(Object.keys(samples[0]).map(key => {
    const values = samples.map(sample => sample[key]).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    const p95 = values[Math.ceil(values.length * 0.95) - 1];
    return [key, { median: Math.round(median * 10) / 10, p95: Math.round(p95 * 10) / 10 }];
  }));
}

async function main() {
  const [option, extra] = process.argv.slice(2);
  if (extra) throw new Error('Use one option: --samples=5 or --fixture=PATH.');
  if (option?.startsWith('--fixture=')) {
    const destination = option.slice('--fixture='.length);
    if (!destination) throw new Error('Choose a new fixture folder.');
    await writeFixture(path.resolve(destination));
    return;
  }
  const count = option === undefined ? 5 : Number(/^--samples=(\d+)$/.exec(option)?.[1]);
  if (!Number.isInteger(count) || count < 1 || count > 30) throw new Error('Choose 1–30 benchmark samples.');
  const cleanup = [];
  const folder = await temporaryFolder({ after: action => cleanup.push(action) }, 'cevra-benchmark-');
  try {
    const root = path.join(folder, 'workspace');
    await writeFixture(root);
    const results = [];
    for (let index = 0; index < count; index++) {
      results.push(await sample(root, path.join(folder, 'profile-' + index)));
    }
    console.log(JSON.stringify({
      platform: os.platform(), osRelease: os.release(), cpu: os.cpus()[0]?.model, node: process.version,
      electron: require('electron/package.json').version, files: featureCount + 3, samples: count,
      verifiedNavigation: { correct: count * 3, attempted: count * 3 },
      timingsMs: summarize(results),
    }, null, 2));
  } finally {
    for (const action of cleanup) await action();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
