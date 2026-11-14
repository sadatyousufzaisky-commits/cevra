const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { openWorkbench } = require('./desktop-workbench.cjs');

const flag = '--enable-intelligence-mock';
const source = 'const privateFixture = "G1 PRIVATE SOURCE";\n';
const response = 'This is an offline mock response.';

test('Intelligence is off by default and the workbench cannot open the preview', { timeout: 25_000 }, async t => {
  const { app, page, open, editor } = await openWorkbench(t, { 'source.js': source });
  await open('source.js');
  assert.equal(await page.getByRole('button', { name: 'VOKRI Intelligence', exact: true }).count(), 0);
  const reason = await page.evaluate(() => window.cevra.openIntelligenceMock().then(() => '', error => error.message));
  assert.match(reason, /Intelligence mock is disabled/);
  assert.equal(app.windows().length, 1);
  assert.match(await editor.textContent(), /G1 PRIVATE SOURCE/);
});

test('the opt-in Electron mock streams, stops, retries and clears the session on workspace change',
  { timeout: 45_000 }, async t => {
    let other;
    const workbench = await openWorkbench(t, { 'source.js': source }, async (_project, profile) => {
      other = path.join(path.dirname(profile), 'second project');
      await fs.mkdir(other);
      await fs.writeFile(path.join(other, 'new.js'), 'const next = true;\n');
    }, { args: [flag] });
    const { app, page } = workbench;
    await app.evaluate(({ session }) => {
      globalThis.intelligenceTraffic = [];
      session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => {
        if (/^(?:https?|wss?):/i.test(url)) {
          globalThis.intelligenceTraffic.push(url);
          done({ cancel: true });
        } else done({});
      });
    });
    await workbench.open('source.js');
    assert.equal(await page.evaluate(() => window.intelligenceMock), undefined);
    const launch = async () => {
      const opened = app.waitForEvent('window');
      await page.getByRole('button', { name: 'VOKRI Intelligence', exact: true }).click();
      const panel = await opened;
      await panel.getByRole('status').getByText('Ready.', { exact: true }).waitFor();
      return panel;
    };
    const panel = await launch();
    assert.equal(await panel.evaluate(() => typeof window.cevra), 'undefined');
    assert.equal(await panel.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await panel.getByLabel('Model', { exact: true }).inputValue(), 'deterministic-v1');
    const prompt = panel.getByRole('textbox', { name: 'Prompt', exact: true });
    const output = panel.getByLabel('Mock response', { exact: true });
    const status = panel.getByRole('status');
    await panel.evaluate(() => {
      const output = document.getElementById('response');
      const stop = document.getElementById('stop');
      const observer = new MutationObserver(() => {
        if (!output.textContent) return;
        observer.disconnect();
        stop.click();
      });
      observer.observe(output, { childList: true });
    });
    await prompt.fill('Test prompt.');
    await panel.getByRole('button', { name: 'Send', exact: true }).press('Enter');
    await status.getByText('Request stopped.', { exact: true }).waitFor();
    assert.equal(await output.textContent(), 'This ');
    await panel.getByRole('button', { name: 'Retry', exact: true }).click();
    await status.getByText('Response complete.', { exact: true }).waitFor();
    assert.equal(await output.textContent(), response);
    await panel.getByText('Simulated usage · 3 input / 6 output tokens', { exact: true }).waitFor();

    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, other);
    const closed = panel.waitForEvent('close');
    await page.locator('#open-folder').click();
    await closed;
    await workbench.file('new.js').waitFor();
    const fresh = await launch();
    assert.equal(await fresh.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue(), '');
    assert.equal(await fresh.getByLabel('Mock response', { exact: true }).textContent(), '');
    assert.deepEqual(await app.evaluate(() => globalThis.intelligenceTraffic), []);
    assert.equal(await fs.readFile(path.join(workbench.project, 'source.js'), 'utf8'), source);
  });
