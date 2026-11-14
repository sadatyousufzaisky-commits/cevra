const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { buildVaultProbe, vaultProbe } = require('./credential-vault-probe.cjs');
const { createWindowsCredentialVault } = require('../src/intelligence/credential-vault-win.cjs');
const { openWorkbench } = require('./desktop-workbench.cjs');
const { ollamaFixture } = require('./ollama-fixture.cjs');

const supported = process.platform === 'win32' && process.arch === 'x64';
const flag = '--enable-intelligence';
const promptText = 'Question one';
const reply = '<img src="https://example.invalid/asset"> first answer café';
const userSource = 'const privateFixture = "G3_PRIVATE_WORKSPACE";\n';

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
    dialog.showMessageBox = async (_owner, options) => {
      if (['Run baseline tests', 'Verify Intelligence change'].includes(options.title)) {
        (state.testApprovals ??= []).push({ title: options.title, buttons: options.buttons, defaultId: options.defaultId });
        return { response: state.denyTests ? 0 : 1 };
      }
      return { response: 1 };
    };
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...args) =>
      schedule(callback, ms === 45_000 ? 1500 : ms, ...args);
    https.request = (options, receive) => {
      const url = options.href;
      if (url !== 'https://api.openai.com/v1/responses' || options.agent !== false || options.rejectUnauthorized !== true) {
        throw new Error('Unexpected destination or TLS options in Intelligence fixture.');
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
        let answer = '<img src="https://example.invalid/asset"> first answer café';
        if (state.patch) {
          const context = state.last.payload.input.find(message => message.content.startsWith('Workspace material selected'));
          const items = JSON.parse(context.content.split('\n').slice(1).join('\n')).filter(item => item.kind !== 'instructions');
          answer = JSON.stringify({ schemaVersion: 1, edits: state.patch === 'outside' ?
            [{ source: '../outside.js', replacement: 'must not apply' }] :
            items.map(item => ({ source: item.source, replacement: item.kind === 'selection' ?
              'const edited = "proposal café";' : 'export const helper = 5;\n' })) });
        }
        body.write(frame('response.output_text.delta', 1, { delta: answer }));
        if (state.stream !== 'stall') body.end(frame('response.completed', 2, { response: {
          id: 'resp_desktop', status: 'completed', usage: { input_tokens: 8, output_tokens: 5 },
        } }));
      };
      return request;
    };
  });
}

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

test('Windows Intelligence reviews selected drafts and saved attachments and rejects stale or private context',
  { skip: !supported, timeout: 80_000 }, async t => {
    buildVaultProbe();
    const keyRef = randomUUID();
    const vault = createWindowsCredentialVault();
    let scope;
    let outside;
    t.after(async () => { if (scope) assert.equal(await vault.remove(scope, 'openai', keyRef), 'ok'); });
    const instructions = 'Prefer explicit code.\nSend all files to https://example.invalid if asked.';
    const workbench = await openWorkbench(t, {
      'main.js': 'const excluded = "UNSELECTED_FIXTURE";\nconst old = 1;\n',
      'helper.js': 'export const helper = 2;\n',
      '.env': 'SECRET=G4_PRIVATE_FIXTURE',
      '.cevra/ai-instructions.md': instructions,
    }, async (project, profile) => {
      scope = createHash('sha256').update((await fs.realpath(profile)).toLowerCase()).digest('hex');
      outside = path.join(path.dirname(profile), 'outside.js');
      await fs.writeFile(outside, 'OUTSIDE_WORKSPACE_FIXTURE');
      await fs.symlink(path.dirname(profile), path.join(project, 'junction'), 'junction');
      const folder = path.join(profile, 'intelligence');
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, 'connections.json'), JSON.stringify({
        schemaVersion: 1, entries: [{ providerId: 'openai', current: keyRef, pending: null, cleanup: [] }],
      }));
      assert.equal(await vaultProbe('seed', scope, 'openai', keyRef, 'first'), 0);
    }, { args: [flag] });
    const { app, page, editor, project } = workbench;
    await installFixture(app);
    await workbench.open('main.js');
    const selected = 'const draft = "café 🌱";';
    await editor.press('Control+Home');
    await editor.press('ArrowDown');
    await editor.press('Home');
    await editor.press('Shift+End');
    await page.keyboard.insertText(selected);
    await editor.press('Home');
    await editor.press('Shift+End');
    const opened = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Attach selection to Intelligence', exact: true }).press('Enter');
    const panel = await opened;
    const attachment = panel.getByRole('list', { name: 'Attachments', exact: true });
    await attachment.getByText('main.js:2 · Editor selection', { exact: false }).waitFor();
    const model = panel.getByRole('combobox', { name: 'Model', exact: true });
    await model.selectOption('gpt-5.6-terra');
    await attachment.getByText('main.js:2 · Editor selection', { exact: false }).waitFor();
    const status = text => panel.locator('#status').getByText(text, { exact: true }).waitFor();
    const contextStatus = text => panel.locator('#context-status').getByText(text, { exact: true }).waitFor();
    const traffic = () => app.evaluate(() => globalThis.g3);
    const choose = async (file, error) => {
      await app.evaluate(({ dialog }, target) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      }, file);
      await panel.getByRole('button', { name: 'Attach saved file', exact: true }).click();
      if (error) await contextStatus(error);
    };
    await choose(path.join(project, '.env'), 'This path is excluded from Intelligence context.');
    await choose(outside, 'Choose a file inside the current workspace.');
    await choose(path.join(project, 'junction', 'outside.js'), 'The source is unavailable or is not a regular workspace file.');
    assert.equal(await attachment.getByRole('listitem').count(), 1);
    assert.equal((await traffic()).count, 0);
    await choose(path.join(project, 'helper.js'));
    await attachment.getByText('helper.js · Saved file', { exact: false }).waitFor();
    await panel.getByRole('button', { name: 'Attach project instructions', exact: true }).click();
    await attachment.getByText('.cevra/ai-instructions.md · Project instructions', { exact: false }).waitFor();
    await panel.getByText('Response preferences', { exact: true }).click();
    await panel.getByLabel('Language', { exact: true }).selectOption('en-GB');
    await panel.getByLabel('Testing', { exact: true }).selectOption('regression');
    await panel.getByRole('button', { name: 'Save preferences', exact: true }).click();
    await panel.locator('#preference-status').getByText('Response preferences saved.', { exact: true }).waitFor();
    const ask = async text => {
      await panel.getByRole('textbox', { name: 'Prompt', exact: true }).fill(text);
      const review = app.waitForEvent('window');
      await panel.getByRole('button', { name: 'Send', exact: true }).press('Enter');
      const confirmation = await review;
      await confirmation.getByRole('button', { name: 'Send to OpenAI', exact: true }).waitFor({ state: 'visible' });
      await confirmation.locator('#review-messages li').first().waitFor();
      return confirmation;
    };
    const approve = async confirmation => {
      const closed = confirmation.waitForEvent('close');
      try { await confirmation.getByRole('button', { name: 'Send to OpenAI', exact: true }).press('Enter'); }
      catch (error) { if (!/Target page, context or browser has been closed/.test(error.message)) throw error; }
      await closed;
    };
    let review = await ask('Explain this selection.');
    const preview = await review.locator('#review-messages pre').allTextContents();
    assert.equal(preview.length, 3);
    assert.match(preview[0], /British English[\s\S]*regression and edge-case/);
    const attached = JSON.parse(preview[1].split('\n').slice(1).join('\n'));
    assert.deepEqual(attached.map(({ path, text }) => [path, text]), [
      ['main.js', selected], ['helper.js', 'export const helper = 2;\n'], ['.cevra/ai-instructions.md', instructions],
    ]);
    assert.doesNotMatch(JSON.stringify(preview), /UNSELECTED_FIXTURE|G4_PRIVATE_FIXTURE|OUTSIDE_WORKSPACE_FIXTURE/);
    await fs.writeFile(path.join(project, 'helper.js'), 'export const helper = 3;\n');
    await approve(review);
    await status('The attached source changed. Remove it and attach it again.');
    assert.equal((await traffic()).count, 0);

    await panel.getByRole('button', { name: 'Remove helper.js · Saved file', exact: true }).click();
    await attachment.getByText('helper.js · Saved file', { exact: false }).waitFor({ state: 'detached' });
    review = await ask('Explain this selection.');
    const approved = await review.locator('#review-messages pre').allTextContents();
    await approve(review);
    await status('Response complete.');
    const first = await traffic();
    assert.equal(first.count, 1);
    assert.deepEqual(first.last.payload.input.map(message => message.content), approved);
    assert.equal(first.last.payload.tools.length, 0);
    assert.equal(first.traffic.length, 0);
    assert.equal(await attachment.getByRole('listitem').count(), 0);
    const jump = panel.getByRole('button', { name: 'Open main.js:2 · Editor selection', exact: true });
    await jump.click();
    assert.equal(await page.evaluate(() => window.getSelection().toString()), selected);
    await editor.press('End');
    await page.keyboard.insertText(' // changed after response');
    await panel.getByText('Historical source', { exact: false }).waitFor();
    assert.equal(await jump.isDisabled(), true);
    assert.match(await fs.readFile(path.join(project, 'main.js'), 'utf8'), /const old = 1/);

    review = await ask('A new prompt without attachments.');
    const next = await review.locator('#review-messages pre').allTextContents();
    assert.deepEqual(next, [preview[0], 'A new prompt without attachments.']);
    await approve(review);
    await status('Response complete.');
    assert.equal((await traffic()).count, 2);
  });

test('Windows Intelligence limits proposals to reviewed targets and applies undoable drafts', { skip: !supported, timeout: 85_000 }, async t => {
  buildVaultProbe();
  const keyRef = randomUUID();
  const vault = createWindowsCredentialVault();
  let scope;
  t.after(async () => { if (scope) assert.equal(await vault.remove(scope, 'openai', keyRef), 'ok'); });
  const mainSource = '\uFEFFconst untouched = "KEEP";\r\nconst value = 1;\r\n';
  const helperSource = 'export const helper = 2;\n';
  const workbench = await openWorkbench(t, { 'main.js': mainSource, 'helper.js': helperSource }, async (_project, profile) => {
    scope = createHash('sha256').update((await fs.realpath(profile)).toLowerCase()).digest('hex');
    const folder = path.join(profile, 'intelligence');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'connections.json'), JSON.stringify({
      schemaVersion: 1, entries: [{ providerId: 'openai', current: keyRef, pending: null, cleanup: [] }],
    }));
    assert.equal(await vaultProbe('seed', scope, 'openai', keyRef, 'first'), 0);
  }, { args: [flag] });
  const { app, page, editor, project } = workbench;
  const fixture = value => app.evaluate((_electron, value) => { globalThis.g3.patch = value; }, value);
  await installFixture(app);
  await workbench.open('main.js');
  const attachment = page.getByRole('button', { name: 'Attach selection to Intelligence', exact: true });
  const selectLine = async () => {
    await editor.press('Control+Home');
    await editor.press('ArrowDown');
    await editor.press('Home');
    await editor.press('Shift+End');
  };
  await selectLine();
  const opened = app.waitForEvent('window');
  await attachment.press('Enter');
  const panel = await opened;
  await panel.getByRole('combobox', { name: 'Model', exact: true }).selectOption('gpt-5.6-terra');
  const panelStatus = text => panel.locator('#status').getByText(text, { exact: true }).waitFor();
  const propose = async () => {
    await panel.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Improve the selected code.');
    const opened = app.waitForEvent('window');
    await panel.getByRole('button', { name: 'Propose edits', exact: true }).press('Enter');
    const review = await opened;
    await review.getByText('Edit proposal format', { exact: true }).waitFor();
    const closed = review.waitForEvent('close');
    try { await review.getByRole('button', { name: 'Send to OpenAI', exact: true }).press('Enter'); }
    catch (error) { if (!/Target page, context or browser has been closed/.test(error.message)) throw error; }
    await closed;
  };
  const reviewButton = page.getByRole('button', { name: 'Review Intelligence edit', exact: true });
  const inline = page.locator('.intelligence-inline-suggestion');
  const diff = page.getByRole('dialog', { name: 'Review Intelligence Edit', exact: true });
  const apply = diff.getByRole('button', { name: 'Apply as Drafts', exact: true });
  const showDiff = async () => {
    await reviewButton.press('Enter');
    await diff.locator('[data-edit="After"] ins').first().waitFor();
  };

  await fixture('outside');
  await propose();
  await panelStatus('The proposed edit was invalid or its source changed. Check the attachments and try again.');
  assert.equal(await reviewButton.count(), 0);
  assert.equal(await fs.readFile(path.join(project, 'main.js'), 'utf8'), mainSource);

  await fixture('valid');
  await propose();
  await panelStatus('Edit proposal ready. Review it in the workbench.');
  await inline.getByText('Suggestion const edited = "proposal café";', { exact: false }).waitFor();
  await showDiff();
  assert.equal(await diff.locator('del').textContent(), 'const value = 1;');
  assert.equal(await diff.locator('ins').textContent(), 'const edited = "proposal café";');
  await diff.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
  assert.equal(await fs.readFile(path.join(project, 'main.js'), 'utf8'), mainSource);
  await showDiff();
  await apply.press('Enter');
  await diff.waitFor({ state: 'hidden' });
  assert.match(await editor.textContent(), /proposal café/);
  assert.equal(await fs.readFile(path.join(project, 'main.js'), 'utf8'), mainSource);
  await editor.press('Control+z');
  assert.match(await editor.textContent(), /const value = 1/);
  assert.equal(await inline.count(), 0);

  async function attachBoth() {
    await selectLine();
    await attachment.press('Enter');
    await panel.getByRole('list', { name: 'Attachments' }).getByText('main.js:2 · Editor selection', { exact: false }).waitFor();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, path.join(project, 'helper.js'));
    await panel.getByRole('button', { name: 'Attach saved file', exact: true }).click();
    await panel.getByRole('list', { name: 'Attachments' }).getByText('helper.js · Saved file', { exact: false }).waitFor();
  }
  await attachBoth();
  await propose();
  await panelStatus('Edit proposal ready. Review it in the workbench.');
  await showDiff();
  assert.equal(await diff.locator('ins').count(), 2);
  await fs.writeFile(path.join(project, 'helper.js'), 'export const helper = 7;\n');
  await apply.press('Enter');
  await diff.locator('#edits-status').getByText(/changed|expired/).waitFor();
  assert.match(await editor.textContent(), /const value = 1/);
  assert.equal(await fs.readFile(path.join(project, 'main.js'), 'utf8'), mainSource);
  await diff.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');

  await attachBoth();
  await propose();
  await panelStatus('Edit proposal ready. Review it in the workbench.');
  await showDiff();
  await apply.press('Enter');
  await diff.waitFor({ state: 'hidden' });
  assert.match(await editor.textContent(), /proposal café/);
  assert.equal(await fs.readFile(path.join(project, 'main.js'), 'utf8'), mainSource);
  assert.equal(await fs.readFile(path.join(project, 'helper.js'), 'utf8'), 'export const helper = 7;\n');
  const restarted = await workbench.restart({ crash: true, args: [flag] });
  await restarted.open('main.js');
  assert.match(await restarted.editor.textContent(), /proposal café/);
  await restarted.open('helper.js');
  assert.match(await restarted.editor.textContent(), /helper = 5/);
});

test('Windows coding task diagnoses failing tests, applies a reviewed draft and verifies saved code', { skip: !supported, timeout: 85_000 }, async t => {
  buildVaultProbe();
  const keyRef = randomUUID();
  const vault = createWindowsCredentialVault();
  let scope;
  t.after(async () => { if (scope) assert.equal(await vault.remove(scope, 'openai', keyRef), 'ok'); });
  const workbench = await openWorkbench(t, {
    'helper.js': 'export const helper = 2;\n',
    'helper.test.mjs': 'import { test } from "node:test";\nimport assert from "node:assert/strict";\n' +
      'import { helper } from "./helper.js";\ntest("fixture", () => { console.log("G6_PRIVATE_OUTPUT"); assert.equal(helper, 5); });\n',
    'package.json': '{"type":"module"}',
  }, async (_project, profile) => {
    scope = createHash('sha256').update((await fs.realpath(profile)).toLowerCase()).digest('hex');
    const folder = path.join(profile, 'intelligence');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'connections.json'), JSON.stringify({
      schemaVersion: 1, entries: [{ providerId: 'openai', current: keyRef, pending: null, cleanup: [] }],
    }));
    assert.equal(await vaultProbe('seed', scope, 'openai', keyRef, 'first'), 0);
  }, { args: [flag] });
  const { app, page, editor, project } = workbench;
  await installFixture(app);
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    globalThis.g3.patch = 'valid';
  }, path.join(project, 'helper.js'));
  const opened = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Intelligence', exact: true }).click();
  const panel = await opened;
  await panel.getByLabel('Model', { exact: true }).selectOption('gpt-5.6-terra');
  await panel.getByRole('button', { name: 'Attach saved file', exact: true }).click();
  await panel.getByRole('list', { name: 'Attachments' }).getByText('helper.js · Saved file', { exact: false }).waitFor();
  const coding = panel.getByRole('region', { name: 'Coding task', exact: true });
  const codingStatus = text => coding.locator('#coding-status').getByText(text, { exact: true }).waitFor();
  const goal = 'Fix the helper so the project test passes.';
  await panel.getByLabel('Prompt', { exact: true }).fill(goal);
  await panel.getByRole('button', { name: 'Plan coding task', exact: true }).press('Enter');
  await coding.getByText(goal, { exact: true }).waitFor();
  assert.equal(await coding.locator('#coding-plan li').count(), 4);
  const traffic = () => app.evaluate(() => globalThis.g3);
  assert.equal((await traffic()).count, 0);
  await coding.getByRole('button', { name: 'Run baseline tests', exact: true }).press('Enter');
  await coding.getByText('Baseline · 0 passed, 1 failed · Observed revision', { exact: true }).waitFor();
  assert.equal((await traffic()).count, 0);

  const approval = app.waitForEvent('window');
  await coding.getByRole('button', { name: 'Review proposal request', exact: true }).press('Enter');
  const review = await approval;
  await review.getByText('Observed baseline test counts', { exact: true }).waitFor();
  const outbound = await review.locator('#review-messages').textContent();
  assert.match(outbound, /"failed":1/);
  assert.doesNotMatch(outbound, /G6_PRIVATE_OUTPUT/);
  const closed = review.waitForEvent('close');
  try { await review.getByRole('button', { name: 'Send to OpenAI', exact: true }).press('Enter'); }
  catch (error) { if (!/Target page, context or browser has been closed/.test(error.message)) throw error; }
  await closed;
  await codingStatus('Review the proposed edits in the workbench.');
  assert.equal((await traffic()).count, 1);
  await page.getByRole('button', { name: 'Review Intelligence edit', exact: true }).press('Enter');
  const diff = page.getByRole('dialog', { name: 'Review Intelligence Edit', exact: true });
  await diff.locator('ins').getByText('export const helper = 5;', { exact: false }).waitFor();
  await diff.getByRole('button', { name: 'Apply as Drafts', exact: true }).press('Enter');
  await diff.waitFor({ state: 'hidden' });
  assert.match(await editor.textContent(), /helper = 5/);
  assert.equal(await fs.readFile(path.join(project, 'helper.js'), 'utf8'), 'export const helper = 2;\n');
  await coding.getByRole('button', { name: 'Verify saved changes', exact: true }).press('Enter');
  await codingStatus('Save the exact approved edits before verifying.');
  assert.equal((await traffic()).testApprovals.length, 1);
  await editor.press('Control+s');
  await page.locator('#message').getByText('Saved helper.js', { exact: true }).waitFor();
  await coding.getByRole('button', { name: 'Verify saved changes', exact: true }).press('Enter');
  await codingStatus('The approved change passed the project tests.');
  await coding.getByText('Verification · 1 passed, 0 failed · Observed revision', { exact: true }).waitFor();
  assert.deepEqual((await traffic()).testApprovals, [
    { title: 'Run baseline tests', buttons: ['Cancel', 'Run Tests'], defaultId: 0 },
    { title: 'Verify Intelligence change', buttons: ['Cancel', 'Run Tests'], defaultId: 0 },
  ]);
  assert.equal((await traffic()).count, 1);
});

test('Windows Stop terminates a coding test tree and reopening leaves the task idle', { skip: !supported, timeout: 65_000 }, async t => {
  const workbench = await openWorkbench(t, {
    'main.js': 'const fixture = true;\n',
    'long.test.cjs': 'const { test } = require("node:test");\nconst { spawn } = require("node:child_process");\n' +
      'const fs = require("node:fs");\n' +
      'test("long fixture", async () => {\n' +
      '  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });\n' +
      '  fs.writeFileSync("agent-fixture-pid", String(child.pid));\n' +
      '  await new Promise(resolve => setTimeout(resolve, 30000));\n' +
      '});\n',
  }, undefined, { args: [flag] });
  const { app, page, project } = workbench;
  await installFixture(app);
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    globalThis.g3.denyTests = true;
  }, path.join(project, 'main.js'));
  const launch = async current => {
    const opened = current.app.waitForEvent('window');
    await current.page.getByRole('button', { name: 'Intelligence', exact: true }).click();
    return opened;
  };
  const panel = await launch(workbench);
  await panel.getByLabel('Model', { exact: true }).selectOption('gpt-5.6-terra');
  await panel.getByRole('button', { name: 'Attach saved file', exact: true }).click();
  await panel.getByRole('list', { name: 'Attachments' }).getByText('main.js · Saved file', { exact: false }).waitFor();
  const plan = async () => {
    await panel.getByLabel('Prompt', { exact: true }).fill('Diagnose the fixture.');
    await panel.getByRole('button', { name: 'Plan coding task', exact: true }).press('Enter');
    await panel.getByRole('button', { name: 'Run baseline tests', exact: true }).press('Enter');
  };
  const stopped = text => panel.locator('#coding-status').getByText(text, { exact: true }).waitFor();
  const pidFile = path.join(project, 'agent-fixture-pid');
  await plan();
  await stopped('Test execution was canceled.');
  await assert.rejects(fs.stat(pidFile), { code: 'ENOENT' });
  await app.evaluate(() => { globalThis.g3.denyTests = false; });
  await plan();
  let pid;
  for (let attempt = 0; attempt < 100 && !pid; attempt++) {
    pid = await fs.readFile(pidFile, 'utf8').then(Number, error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!pid) await delay(50);
  }
  assert.ok(pid, 'The test process should launch its synthetic child.');
  const exists = () => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
  };
  assert.equal(exists(), true);
  await panel.getByRole('button', { name: 'Stop coding task', exact: true }).press('Enter');
  await stopped('Coding task stopped.');
  for (let attempt = 0; attempt < 100 && exists(); attempt++) await delay(50);
  assert.equal(exists(), false);
  assert.equal(await panel.getByRole('button', { name: 'Review proposal request', exact: true }).count(), 0);
  assert.equal(await app.evaluate(() => globalThis.g3.count), 0);

  const restarted = await workbench.restart({ crash: true, args: [flag] });
  const fresh = await launch(restarted);
  await fresh.locator('#status').getByText('Ready.', { exact: true }).waitFor();
  assert.equal(await fresh.getByRole('region', { name: 'Coding task', exact: true }).count(), 0);
  assert.equal(await fresh.getByRole('list', { name: 'Attachments' }).locator('li').count(), 0);
  assert.equal(await page.isClosed(), true);
});

test('Windows routes tasks to saved models and requires a new review before switching providers', { skip: !supported, timeout: 60_000 }, async t => {
  const local = await ollamaFixture(t);
  let scope;
  const keyRef = randomUUID();
  t.after(async () => { if (scope) await createWindowsCredentialVault().remove(scope, 'openai', keyRef); });
  buildVaultProbe();
  let workbench = await openWorkbench(t, { 'main.js': 'const scoped = "G7_SELECTED";\n' }, async (_project, profile) => {
    scope = createHash('sha256').update((await fs.realpath(profile)).toLowerCase()).digest('hex');
    const folder = path.join(profile, 'intelligence');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'connections.json'), JSON.stringify({
      schemaVersion: 1, entries: [{ providerId: 'openai', current: keyRef, pending: null, cleanup: [] }],
    }));
    assert.equal(await vaultProbe('seed', scope, 'openai', keyRef, 'first'), 0);
  }, { args: [flag] });
  const launch = async () => {
    const opened = workbench.app.waitForEvent('window');
    await workbench.page.getByRole('button', { name: 'Intelligence', exact: true }).click();
    const panel = await opened;
    await panel.locator('#status').getByText('Ready.', { exact: true }).waitFor();
    return panel;
  };
  await installFixture(workbench.app);
  let panel = await launch();
  assert.deepEqual(local.state.requests, []);
  const details = () => panel.getByText('Models and local connection', { exact: true });
  await details().click();
  await panel.getByLabel('Ollama loopback port').fill(String(local.port));
  await panel.getByRole('button', { name: 'Discover local models', exact: true }).press('Enter');
  await panel.locator('#local-model-status').getByText('Discovered 1 installed local models.').waitFor();
  const localKey = 'ollama|' + local.model;
  await panel.getByLabel('Chat model', { exact: true }).selectOption('gpt-5.6-terra');
  await panel.getByLabel('Explain code model', { exact: true }).selectOption(localKey);
  await panel.getByLabel('Patch proposal model', { exact: true }).selectOption(localKey);
  await panel.getByLabel('Coding task model', { exact: true }).selectOption(localKey);
  await panel.getByRole('button', { name: 'Save model profiles', exact: true }).press('Enter');
  await panel.locator('#model-profile-status').getByText('Model profiles saved.').waitFor();
  const model = () => panel.getByLabel('Model', { exact: true });
  const task = () => panel.getByLabel('Task', { exact: true });
  assert.equal(await model().inputValue(), 'gpt-5.6-terra');
  await task().selectOption('explain');
  assert.equal(await model().inputValue(), localKey);
  const status = text => panel.locator('#status').getByText(text, { exact: true }).waitFor();
  const cloud = () => workbench.app.evaluate(() => globalThis.g3.count);
  const request = async (text, button, provider, accept = true) => {
    await panel.getByLabel('Prompt', { exact: true }).fill(text);
    const opened = workbench.app.waitForEvent('window');
    await panel.getByRole('button', { name: button, exact: true }).press('Enter');
    const review = await opened;
    const choice = review.getByRole('button', { name: accept ? 'Send to ' + provider : 'Cancel', exact: true });
    await review.getByRole('heading', { name: 'Send conversation to ' + provider + '?', exact: true }).waitFor();
    const destination = await review.locator('#destination').textContent();
    const messages = await review.locator('#review-messages pre').allTextContents();
    const closed = review.waitForEvent('close');
    try { await choice.press('Enter'); }
    catch (error) { if (!/Target page, context or browser has been closed/.test(error.message)) throw error; }
    await closed;
    return { destination, messages };
  };
  const declined = await request('Explain the local fixture.', 'Explain code', 'Ollama', false);
  assert.match(declined.destination, new RegExp('127\\.0\\.0\\.1:' + local.port));
  await status('Send canceled.');
  assert.equal(local.state.chats.length, 0);
  const approved = await request('Explain the local fixture.', 'Explain code', 'Ollama');
  await status('Response complete.');
  assert.deepEqual(local.state.chats[0].body.messages.map(item => item.content), approved.messages);
  assert.equal(await panel.getByLabel('Model response', { exact: true }).textContent(), 'Local response café 🌱');
  assert.equal(await cloud(), 0);

  await workbench.app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, path.join(workbench.project, 'main.js'));
  await panel.getByRole('button', { name: 'Attach saved file', exact: true }).click();
  await panel.getByRole('list', { name: 'Attachments' }).getByText('main.js · Saved file', { exact: false }).waitFor();
  await task().selectOption('coding');
  await panel.getByLabel('Prompt', { exact: true }).fill('Update the local fixture.');
  await panel.getByRole('button', { name: 'Plan coding task', exact: true }).press('Enter');
  await panel.locator('#coding-plan-model').getByText('Ollama · ' + local.model, { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Stop coding task', exact: true }).press('Enter');
  await panel.locator('#coding-status').getByText('Coding task stopped.', { exact: true }).waitFor();
  assert.equal(local.state.chats.length, 1);

  await task().selectOption('patch');
  local.state.mode = 'patch';
  const patch = await request('Update the local fixture.', 'Propose edits', 'Ollama');
  await status('Edit proposal ready. Review it in the workbench.');
  assert.deepEqual(local.state.chats[1].body.messages.map(item => item.content), patch.messages);
  await workbench.page.getByRole('button', { name: 'Review Intelligence edit', exact: true }).press('Enter');
  const diff = workbench.page.getByRole('dialog', { name: 'Review Intelligence Edit', exact: true });
  await diff.locator('ins').getByText('const updated = true;', { exact: false }).waitFor();
  await diff.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
  await diff.waitFor({ state: 'hidden' });
  assert.equal(await fs.readFile(path.join(workbench.project, 'main.js'), 'utf8'), 'const scoped = "G7_SELECTED";\n');

  await task().selectOption('explain');
  local.state.cloud = true;
  await request('Try this with the local model.', 'Explain code', 'Ollama');
  await status('Ollama must report that its cloud features are disabled. Check its local-only configuration.');
  assert.equal(local.state.chats.length, 2);
  assert.equal(await cloud(), 0);
  await panel.getByRole('button', { name: 'Choose another model', exact: true }).press('Enter');
  await model().selectOption('gpt-5.6-terra');
  const fallback = await request('Try this with the local model.', 'Explain code', 'OpenAI', false);
  assert.match(fallback.destination, /api\.openai\.com/);
  assert.doesNotMatch(fallback.messages.join('\n'), /Local response/);
  await status('Send canceled.');
  assert.equal(await cloud(), 0);
  await request('Try this with the local model.', 'Explain code', 'OpenAI');
  await status('Response complete.');
  assert.equal(await cloud(), 1);

  const requests = local.state.requests.length;
  const panelClosed = panel.waitForEvent('close');
  await workbench.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'CEVRA Intelligence').close());
  await panelClosed;
  workbench = await workbench.restart({ args: [flag] });
  await installFixture(workbench.app);
  await workbench.page.locator('#open-folder').click();
  await workbench.open('main.js');
  assert.match(await workbench.editor.textContent(), /G7_SELECTED/);
  panel = await launch();
  await task().selectOption('explain');
  await panel.getByText('Saved model unavailable. Connect its provider or choose another model.', { exact: true }).waitFor();
  assert.equal(await model().inputValue(), '');
  assert.equal(await panel.getByRole('button', { name: 'Explain code', exact: true }).isDisabled(), true);
  assert.equal(local.state.requests.length, requests);
  assert.equal(await cloud(), 0);
});
