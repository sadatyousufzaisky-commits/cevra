const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { openWorkbench } = require('./desktop-workbench.cjs');

test('Windows Vietnamese Telex commits real preedit events and saves the exact UTF-8 source',
  { timeout: 180_000, skip: process.platform !== 'win32' || process.env.VOKRI_G5_LIVE_IME !== '1' }, async t => {
    const original = '\uFEFF// Windows IME fixture\r\n\n';
    const workbench = await openWorkbench(t, { 'ime-fixture.txt': original });
    const { app, page, editor, project } = workbench;
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.on('page-title-updated', event => event.preventDefault());
      win.setTitle('VOKRI Code - G5 IME validation');
      win.show();
      win.focus();
    });
    await workbench.open('ime-fixture.txt');
    await editor.press('Control+End');
    await page.evaluate(() => {
      const field = document.querySelector('#editor .cm-content');
      window.liveImeEvents = [];
      for (const name of ['compositionstart', 'compositionupdate', 'compositionend']) {
        field.addEventListener(name, event => {
          window.liveImeEvents.push({ type: event.type, data: event.data, trusted: event.isTrusted });
        });
      }
    });
    console.log('G5_LIVE_IME_READY');
    await page.waitForFunction(() => window.liveImeEvents.some(event => event.type === 'compositionend' && event.data.trim() === 'ấ'),
      undefined, { timeout: 145_000 });
    const word = editor.getByText('ấ', { exact: true });
    await word.waitFor();
    const events = await page.evaluate(() => window.liveImeEvents);
    assert.ok(events.some(event => event.trusted && event.type === 'compositionstart'));
    assert.ok(events.some(event => event.trusted && event.type === 'compositionupdate' && event.data));
    const commit = events.findLast(event => event.type === 'compositionend' && event.data.trim() === 'ấ');
    assert.ok(commit);
    const visibleLine = await word.textContent();
    assert.match(visibleLine, /^ấ ?$/);
    await editor.press('Control+z');
    const separateSpaceUndo = await word.count() > 0;
    if (separateSpaceUndo) await editor.press('Control+z');
    await word.waitFor({ state: 'hidden' });
    await editor.press('Control+y');
    if (separateSpaceUndo) await editor.press('Control+y');
    await word.waitFor();
    await editor.press('Control+s');
    await page.locator('#message').getByText('Saved ime-fixture.txt', { exact: true }).waitFor();
    assert.deepEqual(await fs.readFile(path.join(project, 'ime-fixture.txt')), Buffer.from(original + visibleLine));
    const report = { windows: os.release(), inputMethod: 'Vietnamese Telex', committed: 'ấ',
      trustedCompositionStart: true, trustedPreeditUpdate: true, trustedCompositionEnd: commit.trusted,
      undoRedoPassed: true, exactSavePassed: true };
    t.diagnostic(JSON.stringify(report));
    if (process.env.VOKRI_G5_IME_REPORT) {
      await fs.writeFile(process.env.VOKRI_G5_IME_REPORT, JSON.stringify(report, null, 2) + '\n');
    }
  });
