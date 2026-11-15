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
  await page.getByRole('button', { name: 'Turn on VOKRI Intelligence', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'VOKRI Intelligence', exact: true }).count(), 0);
  const reason = await page.evaluate(() => window.cevra.openIntelligenceMock().then(() => '', error => error.message));
  assert.match(reason, /Intelligence is disabled/);
  assert.equal(app.windows().length, 1);
  assert.match(await editor.textContent(), /G1 PRIVATE SOURCE/);
  const opened = page.context().waitForEvent('page');
  await page.getByRole('button', { name: 'Turn on VOKRI Intelligence', exact: true }).press('Enter');
  const pane = await opened;
  await pane.locator('#status').getByText('Ready.', { exact: true }).waitFor();
  await pane.getByLabel('Model', { exact: true }).selectOption('gpt-5.6-terra');
  await pane.getByText('Cloud API', { exact: true }).waitFor();
});

test('G8 moves the same sandboxed conversation between dock and full workspace, then clears it in AI Off',
  { timeout: 35_000 }, async t => {
    const { app, page, open, editor } = await openWorkbench(t, { 'source.js': source }, undefined, { args: [flag] });
    await open('source.js');
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.unmaximize();
      window.setSize(920, 660);
    });
    const theme = page.getByLabel('Theme', { exact: true });
    await theme.focus();
    await theme.selectOption('midnight');
    await page.locator('#message').getByText('Theme saved.', { exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const message = document.getElementById('message');
      const { left, right, width } = message.getBoundingClientRect();
      return left >= 0 && right <= window.innerWidth && width >= 120;
    });
    const paneOpened = page.context().waitForEvent('page');
    await page.getByRole('button', { name: 'Intelligence workspace', exact: true }).press('Enter');
    const pane = await paneOpened;
    await pane.locator('#status').getByText('Ready.', { exact: true }).waitFor();
    const workbench = page.locator('#workbench');
    const heading = pane.getByRole('heading', { name: 'VOKRI Intelligence', exact: true });
    await heading.waitFor();
    assert.equal(await pane.evaluate(() => typeof window.cevra), 'undefined');
    assert.equal(await pane.evaluate(() => typeof window.require), 'undefined');
    const nativeSurface = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map(view =>
      ({ id: view.webContents.id, visible: view.getVisible(), ...view.getBounds() })));
    await page.waitForFunction(() => document.getElementById('workbench').dataset.intelligenceLayout === 'dock');
    const [docked] = await nativeSurface();
    assert.ok(docked.width < 480 && docked.x > 0);
    const prompt = pane.getByRole('textbox', { name: 'Prompt', exact: true });
    await prompt.fill('Draft kept across layout changes.');
    await pane.getByRole('button', { name: 'Full workspace', exact: true }).press('Enter');
    await page.waitForFunction(() => document.getElementById('workbench').dataset.intelligenceLayout === 'workspace');
    await pane.getByRole('button', { name: 'Dock', exact: true }).waitFor();
    assert.equal(await prompt.inputValue(), 'Draft kept across layout changes.');
    assert.equal(await workbench.locator('.workspace-body').evaluate(node => node.inert), true);
    await pane.getByRole('button', { name: 'Send', exact: true }).press('Enter');
    await pane.locator('#status').getByText('Response complete.', { exact: true }).waitFor();
    await pane.getByRole('button', { name: 'Dock', exact: true }).press('Enter');
    await page.waitForFunction(() => document.getElementById('workbench').dataset.intelligenceLayout === 'dock');
    assert.equal((await nativeSurface())[0].id, docked.id);
    assert.equal(await pane.getByLabel('Mock response', { exact: true }).textContent(), response);
    await prompt.fill('Stop this request by turning Intelligence off.');
    await pane.getByRole('button', { name: 'Send', exact: true }).press('Enter');
    await pane.locator('#status').getByText('Streaming…', { exact: true }).waitFor();
    const closed = pane.waitForEvent('close');
    await page.getByRole('button', { name: 'Turn off VOKRI Intelligence', exact: true }).press('Enter');
    await closed;
    await page.getByRole('button', { name: 'Turn on VOKRI Intelligence', exact: true }).waitFor();
    assert.deepEqual(await nativeSurface(), []);
    assert.match(await editor.textContent(), /G1 PRIVATE SOURCE/);

    const newPaneOpened = page.context().waitForEvent('page');
    await page.getByRole('button', { name: 'Turn on VOKRI Intelligence', exact: true }).press('Enter');
    const newPane = await newPaneOpened;
    await newPane.locator('#status').getByText('Ready.', { exact: true }).waitFor();
    assert.equal(await newPane.getByLabel('Prompt', { exact: true }).inputValue(), '');
    assert.equal(await newPane.getByLabel('Mock response', { exact: true }).textContent(), '');
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
