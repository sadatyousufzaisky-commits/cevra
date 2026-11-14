const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { createWindowsCredentialVault } = require('../src/intelligence/credential-vault-win.cjs');
const { buildVaultProbe, vaultProbe } = require('./credential-vault-probe.cjs');
const { openWorkbench } = require('./desktop-workbench.cjs');

const windows = process.platform === 'win32' && process.arch === 'x64';
const flag = '--enable-intelligence-mock';
const provider = 'openai';

test('Windows stores, checks, rotates and deletes API keys through the native prompt and real vault',
  { skip: !windows, timeout: 65_000 }, async t => {
    buildVaultProbe();
    const vault = createWindowsCredentialVault();
    assert.equal(vault.available(), true);
    const refs = new Set();
    let scope;
    t.after(async () => {
      for (const ref of refs) assert.equal(await vault.remove(scope, provider, ref), 'ok');
    });
    let workbench = await openWorkbench(t, { 'source.js': 'const keep = true;\n' }, undefined, { args: [flag] });
    const metadata = path.join(workbench.profile, 'intelligence', 'connections.json');
    const entry = async () => (JSON.parse(await fs.readFile(metadata, 'utf8'))).entries.find(item => item.providerId === provider);
    scope = createHash('sha256').update((await fs.realpath(workbench.profile)).toLowerCase()).digest('hex');
    const dialogs = async () => workbench.app.evaluate(({ dialog }) => {
      globalThis.credentialDisconnect = [];
      dialog.showMessageBox = async (_owner, options) => {
        globalThis.credentialDisconnect.push({ title: options.title, defaultId: options.defaultId });
        return { response: 1 };
      };
    });
    const openConnections = async () => {
      const opened = workbench.app.waitForEvent('window');
      await workbench.page.getByRole('button', { name: 'Intelligence', exact: true }).click();
      const panel = await opened;
      await panel.getByRole('status').getByText('Ready.', { exact: true }).waitFor();
      await panel.getByText('Provider connections', { exact: true }).click();
      const row = panel.getByRole('listitem').filter({ has: panel.getByRole('heading', { name: 'OpenAI', exact: true }) });
      await row.waitFor();
      return {
        panel, row, status: panel.locator('#connection-status'),
        click: name => row.getByRole('button', { name, exact: true }).click(),
      };
    };
    let ui = await openConnections();
    async function beginCapture(action) {
      const owner = await workbench.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .find(window => window.getTitle().includes('Offline mock')).getNativeWindowHandle().readBigUInt64LE().toString(16));
      await ui.click(action);
      let ref;
      for (let attempt = 0; attempt < 120 && !ref; attempt++) {
        ref = await entry().then(value => value?.pending, error => { if (error.code !== 'ENOENT') throw error; });
        if (!ref) await delay(25);
      }
      assert.ok(ref, 'The controller should persist a pending reference before showing the native dialog.');
      refs.add(ref);
      return { owner, ref };
    }
    async function capture(action, value, expected) {
      const { owner, ref } = await beginCapture(action);
      assert.equal(await vaultProbe('prompt', owner, value), 0, 'The native password control must accept the synthetic fixture.');
      await ui.status.getByText(expected, { exact: true }).waitFor();
      return ref;
    }
    async function closePanel() {
      const closed = ui.panel.waitForEvent('close');
      await workbench.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .find(window => window.getTitle().includes('Offline mock')).close());
      await closed;
    }

    assert.equal(await workbench.page.evaluate(() => typeof window.intelligenceMock), 'undefined');
    assert.equal(await ui.panel.evaluate(() => typeof window.cevra), 'undefined');
    assert.deepEqual(await ui.panel.evaluate(() => Object.keys(window.intelligenceMock).sort()), [
      'agentState', 'agentTest', 'attachFile', 'attachInstructions', 'checkKey', 'checkSources', 'cleanupKey', 'clear', 'connections',
      'context', 'disconnectKey', 'models', 'next', 'onAgentChanged', 'onContextChanged', 'openSource', 'preferences',
      'prepareAgent', 'removeContext', 'savePreferences', 'start', 'stop', 'stopAgent', 'storeKey', 'switchModel',
    ]);
    const first = await capture('Add key', 'first', 'Key stored in Windows Credential Manager.');
    assert.equal((await entry()).current, first);
    assert.equal(await vaultProbe('verify', scope, provider, first, 'first'), 0);
    await ui.click('Check key');
    await ui.status.getByText('Windows Credential Manager verified the stored key.', { exact: true }).waitFor();
    const snapshot = await ui.panel.evaluate(() => window.intelligenceMock.connections());
    assert.deepEqual(snapshot.value.entries.find(item => item.providerId === 'openai'),
      { providerId: provider, label: 'OpenAI', state: 'configured' });
    assert.doesNotMatch(JSON.stringify(snapshot), /G2-SYNTHETIC|pending|cleanup":|current":/);
    assert.doesNotMatch(await fs.readFile(metadata, 'utf8'), /G2-SYNTHETIC/);

    const cancelled = await capture('Replace key', 'cancel', 'Action canceled.');
    assert.equal(await vault.inspect(scope, provider, cancelled), 'missing');
    assert.equal(await vaultProbe('verify', scope, provider, first, 'first'), 0);
    const interrupted = await beginCapture('Replace key');
    assert.equal(await vaultProbe('prompt', interrupted.owner, 'wait'), 0);
    await closePanel();
    for (let attempt = 0; attempt < 120 && (await entry()).pending; attempt++) await delay(25);
    assert.equal((await entry()).pending, null);
    assert.equal(await vault.inspect(scope, provider, interrupted.ref), 'missing');
    assert.equal(await vaultProbe('verify', scope, provider, first, 'first'), 0);
    ui = await openConnections();
    const second = await capture('Replace key', 'second', 'Key replaced in Windows Credential Manager.');
    assert.equal((await entry()).current, second);
    assert.equal(await vault.inspect(scope, provider, first), 'missing');
    assert.equal(await vaultProbe('verify', scope, provider, second, 'second'), 0);

    await closePanel();
    workbench = await workbench.restart({ args: [flag] });
    ui = await openConnections();
    await ui.row.getByText('Key configured · Provider verification pending', { exact: true }).waitFor();
    assert.equal(await vaultProbe('verify', scope, provider, second, 'second'), 0);
    await dialogs();
    await ui.click('Disconnect');
    await ui.status.getByText('Key removed from Windows Credential Manager.', { exact: true }).waitFor();
    assert.deepEqual(await workbench.app.evaluate(() => globalThis.credentialDisconnect),
      [{ title: 'Disconnect provider', defaultId: 0 }]);
    assert.equal(await vault.inspect(scope, provider, second), 'missing');
    assert.equal(await entry(), undefined);
    await ui.row.getByText('No key configured', { exact: true }).waitFor();
  });
