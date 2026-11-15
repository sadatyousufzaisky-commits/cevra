const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { openWorkbench } = require('./desktop-workbench.cjs');

async function command(page, name) {
  await page.keyboard.press('Control+Shift+P');
  const center = page.getByRole('dialog', { name: 'Command center' });
  await center.getByRole('combobox').fill(name);
  await center.getByRole('option', { name, exact: true }).click();
}

test('G5 command center drives folding, multi-cursor, and read-only review against the saved file',
  { timeout: 40_000 }, async t => {
    const source = 'function example() {\n  const first = 1;\n  const second = 2;\n  return first + second;\n}\n';
    const workbench = await openWorkbench(t, { 'example.js': source });
    const { page, editor, project } = workbench;
    await workbench.open('example.js');
    await editor.press('Control+Home');
    await command(page, 'Fold at cursor');
    await page.locator('#editor .cm-foldPlaceholder').waitFor();
    await command(page, 'Unfold at cursor');
    await page.locator('#editor .cm-foldPlaceholder').waitFor({ state: 'hidden' });
    await editor.press('ArrowDown');
    await command(page, 'Add Cursor Below');
    await page.keyboard.insertText('// note ');
    await page.locator('#draft-status[data-state="saved"]').waitFor();
    assert.match(await editor.textContent(), /\/\/ note\s+const first.*\/\/ note\s+const second/s);

    await command(page, 'Review Unsaved Changes');
    const review = page.getByRole('dialog', { name: 'Unsaved Changes' });
    await review.getByText(/last verified disk revision/).waitFor();
    await review.locator('.cm-deletedChunk').getByText(/const first/).waitFor();
    await review.locator('.cm-changedLine').getByText(/note/).first().waitFor();
    const comparison = review.locator('.cm-content');
    assert.equal(await comparison.getAttribute('contenteditable'), 'false');
    await review.getByRole('button', { name: 'Next Change' }).press('Enter');
    await page.keyboard.insertText('must stay read-only');
    assert.doesNotMatch(await comparison.textContent(), /must stay read-only/);
    await review.getByRole('button', { name: 'Close', exact: true }).press('Enter');
    assert.equal(await fs.readFile(path.join(project, 'example.js'), 'utf8'), source);
    await command(page, 'Undo edit');
    await page.locator('#draft-status[data-state="clear"]').waitFor({ state: 'attached' });
    assert.doesNotMatch(await editor.textContent(), /note/);
  });

test('G5 mixed-ending project replacement recovers both files and converted diagnostics still navigate',
  { timeout: 60_000 }, async t => {
    const main = '\uFEFFconst first = "oldWord";\r\nconst broken = ;\nconst last = "oldWord";\r';
    const nested = '\uFEFFoldWord\nسلام\r\noldWord\r';
    const relative = path.join('nested (QA)', 'café.txt');
    let workbench = await openWorkbench(t, { 'main.js': main, [relative]: nested });
    const { page, editor, project } = workbench;
    await workbench.open('main.js');
    await page.getByRole('button', { name: 'Problems', exact: true }).click();
    await page.locator('#problem-list .problem-row').first().waitFor();
    await editor.press('Control+End');
    await command(page, 'Convert line endings to LF');
    await page.locator('#problem-list .problem-row').first().click();
    await page.locator('#cursor').getByText(/^Ln 2,/).waitFor();
    await editor.press('Control+z');
    await page.locator('#line-ending').getByText('Mixed EOL', { exact: true }).waitFor();

    await editor.press('Control+Home');
    await page.keyboard.insertText('// kept draft\n');
    await page.locator('#draft-status[data-state="saved"]').waitFor();
    await editor.press('Control+Shift+f');
    await page.locator('#search-query').fill('oldWord');
    await page.locator('#replace-text').fill('newWord');
    await page.getByRole('button', { name: 'Preview Replace' }).click();
    const preview = page.getByRole('dialog', { name: 'Replace in Project' });
    await preview.getByText(/4 edits in 2 files/).waitFor();
    await preview.getByRole('button', { name: 'Apply as Drafts' }).click();
    await preview.waitFor({ state: 'hidden' });
    await page.locator('#draft-status[data-state="saved"]').waitFor();
    assert.deepEqual(await fs.readFile(path.join(project, 'main.js')), Buffer.from(main));
    assert.deepEqual(await fs.readFile(path.join(project, relative)), Buffer.from(nested));

    workbench = await workbench.restart({ crash: true });
    await workbench.page.locator('#message').getByText('Recovered 2 unsaved files.').waitFor();
    await workbench.editor.press('Control+Shift+s');
    await workbench.page.locator('#draft-status[data-state="clear"]').waitFor({ state: 'attached' });
    assert.deepEqual(await fs.readFile(path.join(project, 'main.js')), Buffer.from(main.replace('const first', '// kept draft\r\nconst first').replaceAll('oldWord', 'newWord')));
    assert.deepEqual(await fs.readFile(path.join(project, relative)), Buffer.from(nested.replaceAll('oldWord', 'newWord')));
  });

test('G5 Windows Electron IME composition can commit, cancel, undo, and save multilingual source',
  { timeout: 40_000, skip: process.platform !== 'win32' }, async t => {
    const original = '// שלום 🙂\r\nconst text = "";\n';
    const workbench = await openWorkbench(t, { 'composition.js': '\uFEFF' + original });
    const { page, editor, project } = workbench;
    const input = await page.context().newCDPSession(page);
    t.after(() => input.detach().catch(() => {}));
    await workbench.open('composition.js');
    await editor.press('Control+End');
    await editor.press('ArrowUp');
    await editor.press('End');
    await editor.press('ArrowLeft');
    await editor.press('ArrowLeft');
    await page.evaluate(() => {
      window.editorCompositionEvents = [];
      for (const event of ['compositionstart', 'compositionupdate', 'compositionend']) {
        document.querySelector('#editor .cm-content').addEventListener(event, ({ type, data }) => {
          window.editorCompositionEvents.push({ type, data });
        });
      }
    });
    const compose = text => input.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await compose('にほん');
    await editor.getByText(/にほん/).waitFor();
    await compose('');
    await editor.getByText(/にほん/).waitFor({ state: 'hidden' });
    await page.locator('#draft-status[data-state="clear"]').waitFor({ state: 'attached' });

    await compose('に');
    await compose('にほん');
    await input.send('Input.insertText', { text: '日本' });
    await editor.getByText(/日本/).waitFor();
    const events = await page.evaluate(() => window.editorCompositionEvents);
    assert.ok(events.some(event => event.type === 'compositionupdate' && event.data === 'にほん'));
    assert.ok(events.some(event => event.type === 'compositionend' && event.data === '日本'));
    await editor.press('Control+z');
    await editor.getByText(/日本|にほん/).waitFor({ state: 'hidden' });
    await editor.press('Control+y');
    await editor.getByText(/日本/).waitFor();
    await editor.press('Control+s');
    await page.locator('#message').getByText('Saved composition.js', { exact: true }).waitFor();
    assert.deepEqual(await fs.readFile(path.join(project, 'composition.js')), Buffer.from('\uFEFF' + original.replace('""', '"日本"')));
  });

const p95 = samples => Math.round([...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1] * 10) / 10;

test('G5 editor handles long documents, diagnostic load, typing, undo, scrolling and tab churn',
  { timeout: 90_000, skip: process.platform !== 'win32' }, async t => {
    const rows = 24_000;
    const longLine = 65_536;
    const source = '\uFEFF' + Array.from({ length: rows }, (_, index) =>
      `Source row ${index} café שלום` + (index % 2 ? '\r\n' : '\n')).join('') + 'x'.repeat(longLine) + '\nlast row';
    const problemsPerFile = 950;
    const errors = Array.from({ length: problemsPerFile }, (_, index) => `const issue${index} = ;\n`).join('');
    const issues = ['issues-a.js', 'issues-b.js', 'issues-c.js'];
    const files = { 'large.txt': source, 'alternate.txt': source, ...Object.fromEntries(issues.map(name => [name, errors])) };
    const workbench = await openWorkbench(t, files);
    const { page, editor, project } = workbench;
    const cdp = await page.context().newCDPSession(page);
    t.after(() => cdp.detach().catch(() => {}));
    const heap = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      const { usedSize } = await cdp.send('Runtime.getHeapUsage');
      return usedSize;
    };
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    for (const name of issues) await workbench.open(name);
    await page.getByRole('button', { name: 'Problems', exact: true }).click();
    await page.locator('#problems-status').getByText(`${problemsPerFile * issues.length} syntax problems`).waitFor();
    assert.ok(await page.locator('#problem-list .problem-note').count() > 0, 'the diagnostic view exposed its bounded result count');
    await workbench.open('large.txt');
    await editor.press('Control+End');
    await editor.getByText('last row', { exact: true }).waitFor();
    await page.evaluate(() => {
      window.g5InputSamples = [];
      document.querySelector('#editor .cm-content').addEventListener('beforeinput', event => {
        if (event.inputType !== 'insertText') return;
        const start = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => window.g5InputSamples.push(performance.now() - start)));
      });
    });
    const burst = ' draft changes 0123456789';
    await page.keyboard.type(burst, { delay: 12 });
    await page.waitForFunction(length => window.g5InputSamples.length === length, burst.length);
    await page.locator('#draft-status[data-state="saved"]').waitFor();
    assert.deepEqual(await fs.readFile(path.join(project, 'large.txt')), Buffer.from(source));
    const typing = await page.evaluate(() => window.g5InputSamples);
    for (let undo = 0; undo < burst.length; undo++) {
      if ((await page.locator('#draft-status').getAttribute('data-state')) === 'clear') break;
      if (await editor.getByText('last row', { exact: true }).count()) break;
      await editor.press('Control+z');
    }
    await page.locator('#draft-status[data-state="clear"]').waitFor({ state: 'attached' });
    const scroll = await page.evaluate(async () => {
      const scroller = document.querySelector('#editor .cm-scroller');
      const samples = [];
      for (const fraction of [0, 0.15, 0.7, 1, 0.4, 0.9, 0.3, 0]) {
        const start = performance.now();
        scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * fraction;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        samples.push(performance.now() - start);
      }
      return samples;
    });
    await page.evaluate(frame);
    const before = await heap();
    for (let cycle = 0; cycle < 5; cycle++) {
      await workbench.open('alternate.txt');
      await editor.press('Control+End');
      await editor.getByText('last row', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Close alternate.txt', exact: true }).click();
      await workbench.open('large.txt');
    }
    await page.evaluate(frame);
    const retained = await heap() - before;
    const report = { windows: os.release(), electron: await workbench.app.evaluate(() => process.versions.electron),
      sourceBytes: Buffer.byteLength(source), lines: rows + 2, longLine, syntaxProblems: problemsPerFile * issues.length,
      typingSamples: typing.length, scrollSamples: scroll.length, typingP95Ms: p95(typing), scrollP95Ms: p95(scroll),
      churnCycles: 5, retainedRendererHeapBytes: retained };
    assert.ok(report.typingP95Ms < 200, JSON.stringify(report));
    assert.ok(report.scrollP95Ms < 250, JSON.stringify(report));
    assert.ok(retained < 20 * 1024 * 1024, JSON.stringify(report));
    t.diagnostic(JSON.stringify(report));
    if (process.env.VOKRI_G5_BENCHMARK_REPORT) {
      await fs.writeFile(process.env.VOKRI_G5_BENCHMARK_REPORT, JSON.stringify(report, null, 2) + '\n');
    }
  });
