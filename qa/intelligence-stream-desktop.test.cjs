const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { buildVaultProbe, vaultProbe } = require('./credential-vault-probe.cjs');
const { createWindowsCredentialVault } = require('../src/intelligence/credential-vault-win.cjs');
const { openWorkbench } = require('./desktop-workbench.cjs');

const supported = process.platform === 'win32' && process.arch === 'x64';
const flag = '--enable-intelligence';
const promptText = 'Question one';
const reply = '<img src="https://example.invalid/asset"> first answer café';
const userSource = 'const privateFixture = "G3_PRIVATE_WORKSPACE";\n';

test('Windows Intelligence confirms exact live turns, cancels streams and clears session state',
  { skip: !supported, timeout: 80_000 }, async t => {
    buildVaultProbe();
    const keyRef = randomUUID();
    const vault = createWindowsCredentialVault();
    let scope;
    let otherProject;
    t.after(async () => { if (scope) assert.equal(await vault.remove(scope, 'openai', keyRef), 'ok'); });
    const workbench = await openWorkbench(t, { 'main.js': userSource }, async (_project, profile) => {
      scope = createHash('sha256').update((await fs.realpath(profile)).toLowerCase()).digest('hex');
      otherProject = path.join(path.dirname(profile), 'different project');
      await fs.mkdir(otherProject);
      await fs.writeFile(path.join(otherProject, 'other.js'), 'const different = true;\n');
      const folder = path.join(profile, 'intelligence');
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, 'connections.json'), JSON.stringify({
        schemaVersion: 1, entries: [{ providerId: 'openai', current: keyRef, pending: null, cleanup: [] }],
      }));
      assert.equal(await vaultProbe('seed', scope, 'openai', keyRef, 'first'), 0);
    }, { args: [flag] });
    await workbench.open('main.js');

    async function installFixture(app) {
      await app.evaluate(({ dialog, session }) => {
        const https = process.getBuiltinModule('node:https');
        const { EventEmitter } = process.getBuiltinModule('node:events');
        const { PassThrough } = process.getBuiltinModule('node:stream');
        const state = globalThis.g3 = { stream: 'complete', count: 0, aborts: 0, traffic: [] };
        session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => {
          if (/^https?:/.test(url)) { state.traffic.push(url); done({ cancel: true }); }
          else done({});
        });
        dialog.showMessageBox = async () => ({ response: 1 });
        const schedule = globalThis.setTimeout;
        globalThis.setTimeout = (callback, ms, ...args) =>
          schedule(callback, ms === 45_000 ? 1500 : ms, ...args);
        https.request = (options, receive) => {
          const url = options.href;
          if (url !== 'https://api.openai.com/v1/responses' || options.agent !== false || options.rejectUnauthorized !== true) {
            throw new Error('Unexpected destination or TLS options in G3 fixture.');
          }
          const request = new EventEmitter();
          request.end = raw => {
            const receivedKey = options.headers.authorization === 'Bearer G2-SYNTHETIC-KEY-ONE';
            state.last = { url, receivedKey, payload: JSON.parse(raw) };
            state.count++;
            const body = new PassThrough();
            body.statusCode = 200;
            body.headers = { 'content-type': 'text/event-stream' };
            options.signal.addEventListener('abort', () => { state.aborts++; body.destroy(); }, { once: true });
            const frame = (type, seq, props) => 'event: ' + type + '\ndata: ' +
              JSON.stringify({ type, sequence_number: seq, ...props }) + '\n\n';
            receive(body);
            body.write(frame('response.created', 0, { response: { id: 'resp_desktop' } }));
            body.write(frame('response.output_text.delta', 1, {
              delta: '<img src="https://example.invalid/asset"> first answer café',
            }));
            if (state.stream !== 'stall') body.end(frame('response.completed', 2, { response: {
              id: 'resp_desktop', status: 'completed', usage: { input_tokens: 8, output_tokens: 5 },
            } }));
          };
          return request;
        };
      });
    }

    async function openPanel(current) {
      const opened = current.app.waitForEvent('window');
      await current.page.getByRole('button', { name: 'Intelligence', exact: true }).click();
      const panel = await opened;
      await panel.locator('#status').getByText('Ready.', { exact: true }).waitFor();
      await panel.getByRole('combobox', { name: 'Model', exact: true }).selectOption('gpt-5.6-terra');
      await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
      return panel;
    }
    await installFixture(workbench.app);
    let panel = await openPanel(workbench);
    const status = text => panel.locator('#status').getByText(text, { exact: true }).waitFor();
    const review = async (action, allow = true) => {
      const opened = workbench.app.waitForEvent('window');
      await action();
      const confirmation = await opened;
      await confirmation.getByRole('heading', { name: 'Send conversation to OpenAI?', exact: true }).waitFor();
      const decision = confirmation.getByRole('button', { name: allow ? 'Send to OpenAI' : 'Cancel', exact: true });
      const prompts = await confirmation.locator('#review-messages pre').allTextContents();
      const destination = await confirmation.locator('#destination').textContent();
      if (!allow) assert.equal(await decision.evaluate(element => document.activeElement === element), true);
      const closed = confirmation.waitForEvent('close');
      try { await decision.press('Enter'); }
      catch (error) { if (!/Target page, context or browser has been closed/.test(error.message)) throw error; }
      await closed;
      return { prompts, destination };
    };
    const send = async (text, allow) => {
      await panel.getByRole('textbox', { name: 'Prompt', exact: true }).fill(text);
      return review(() => panel.getByRole('button', { name: 'Send', exact: true }).press('Enter'), allow);
    };
    const state = () => workbench.app.evaluate(() => globalThis.g3);
    const declined = await send(promptText, false);
    await status('Send canceled.');
    assert.equal((await state()).count, 0);
    assert.match(declined.destination, /GPT-5.6 Terra .*api\.openai\.com/);
    assert.deepEqual(declined.prompts, [promptText]);

    await send(promptText);
    await status('Response complete.');
    assert.equal(await panel.locator('#response').textContent(), reply);
    assert.equal(await panel.locator('#response img').count(), 0);
    await panel.getByText('OpenAI usage · 8 input / 5 output tokens', { exact: true }).waitFor();
    const nextReview = await send('Question two');
    assert.deepEqual(nextReview.prompts, [promptText, reply, 'Question two']);
    await status('Response complete.');
    const second = await state();
    assert.equal(second.count, 2);
    assert.equal(second.last.receivedKey, true);
    assert.deepEqual(second.last.payload.input, [
      { role: 'user', content: promptText }, { role: 'assistant', content: reply }, { role: 'user', content: 'Question two' },
    ]);
    assert.equal(second.last.payload.store, false);
    assert.doesNotMatch(JSON.stringify(second.last.payload), /G3_PRIVATE_WORKSPACE|G2-SYNTHETIC/);
    assert.deepEqual(second.traffic, []);

    await workbench.app.evaluate(() => { globalThis.g3.stream = 'stall'; });
    await send('Stop this turn');
    await status('Streaming…');
    await panel.locator('#response').getByText(reply, { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Stop', exact: true }).press('Enter');
    await status('Request stopped. OpenAI may charge for usage already processed.');
    const stopped = await state();
    assert.equal(stopped.count, 3);
    assert.ok(stopped.aborts >= 3);
    await workbench.app.evaluate(() => { globalThis.g3.stream = 'complete'; });
    await review(() => panel.getByRole('button', { name: 'Retry', exact: true }).press('Enter'));
    await status('Response complete.');
    assert.deepEqual((await state()).last.payload.input, stopped.last.payload.input);
    assert.equal((await state()).count, 4);

    await panel.getByRole('button', { name: 'New conversation', exact: true }).press('Enter');
    await status('Ready.');
    assert.equal(await panel.locator('#history > li').count(), 0);
    await workbench.app.evaluate(() => { globalThis.g3.stream = 'stall'; });
    await send('Wait for the provider deadline');
    await status('The provider request timed out.');
    assert.ok((await state()).aborts >= 5);
    assert.equal((await state()).count, 5);
    assert.equal(await panel.locator('#history > li').count(), 0);

    await send('Before renderer restart');
    await panel.locator('#response').getByText(reply, { exact: true }).waitFor();
    await workbench.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(window => window.getTitle() === 'CEVRA Intelligence').webContents.forcefullyCrashRenderer();
    });
    const panelClosed = () => workbench.app.evaluate(({ BrowserWindow }) =>
      !BrowserWindow.getAllWindows().some(window => window.getTitle() === 'CEVRA Intelligence'));
    for (let count = 0; count < 100 && !await panelClosed(); count++) await delay(30);
    assert.equal(await panelClosed(), true);
    panel = await openPanel(workbench);
    assert.equal(await panel.locator('#history > li').count(), 0);
    assert.equal(await panel.locator('#response').textContent(), '');
    for (let count = 0; count < 20 && (await state()).aborts < 6; count++) await delay(30);
    assert.ok((await state()).aborts >= 6);
    assert.equal((await state()).count, 6);

    await send('Before workspace switch');
    await panel.locator('#response').getByText(reply, { exact: true }).waitFor();
    const switched = panel.waitForEvent('close');
    await workbench.app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, otherProject);
    await workbench.page.locator('#open-folder').click();
    await switched;
    await workbench.file('other.js').waitFor();
    panel = await openPanel(workbench);
    assert.equal(await panel.locator('#history > li').count(), 0);
    assert.equal(await panel.locator('#response').textContent(), '');

    await send('Before disconnect');
    await panel.locator('#response').getByText(reply, { exact: true }).waitFor();
    await panel.getByText('Provider connections', { exact: true }).click();
    const row = panel.getByRole('listitem').filter({ has: panel.getByRole('heading', { name: 'OpenAI', exact: true }) });
    await row.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await row.getByText('No key configured', { exact: true }).waitFor();
    await status('Request stopped.');
    assert.equal(await vault.inspect(scope, 'openai', keyRef), 'missing');
    assert.ok((await state()).aborts >= 8);
    assert.equal((await state()).count, 8);
    await send('Cannot send with disconnected key');
    await status('OpenAI connection unavailable. Check or replace the key in Provider connections.');
    assert.equal((await state()).count, 8);
  });
