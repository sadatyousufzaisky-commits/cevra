const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { openIsolationLab, artifacts } = require('../src/extensions/host-lab/supervisor.cjs');
const { createExtensionRegistry } = require('../src/extensions/registry.cjs');
const { sha256 } = require('../src/extensions/inspect-package.cjs');
const { executableManifest, executableArchive } = require('./extension-fixtures.cjs');
const { openWorkbench, replaceEditor, assertWindowsProcessStopped } = require('./desktop-workbench.cjs');
const { temporaryFolder } = require('./temp.cjs');

const relative = 'nested/value.js';
const original = 'const answer = 1;\n';
const proposed = 'const answer = 42;\n';

async function runtimeWorkbench(t) {
  const module = await fs.readFile(path.join(artifacts, 'broker-fixture.wasm'));
  const manifest = executableManifest([
    { capability: 'commands.register' }, { capability: 'workspace.read', files: [relative], drafts: true },
    { capability: 'editor.readSelection', files: [relative] },
    { capability: 'diagnostics.publish', files: [relative] }, { capability: 'editor.proposeEdit', files: [relative] },
  ], { id: 'org.cevra.broker-test', displayName: 'Broker Test' });
  const bytes = executableArchive(manifest, module);
  const digest = sha256(bytes);
  const workbench = await openWorkbench(t, { [relative]: original, 'private.txt': 'PRIVATE_SOURCE_MARKER', 'entry.js': 'const entry = true;' },
    async (_project, profile) => {
      const registry = createExtensionRegistry(profile);
      const file = path.join(path.dirname(profile), 'broker test.zip');
      await fs.writeFile(file, bytes);
      await registry.install(file, { reviewedDigest: digest });
      await registry.setEnabled(manifest.id, digest, true);
    });
  await workbench.app.evaluate(({ dialog }) => {
    globalThis.extensionReviews = [];
    dialog.showMessageBox = async (_owner, options) => {
      globalThis.extensionReviews.push({ title: options.title, detail: options.detail, defaultId: options.defaultId });
      return { response: 1 };
    };
  });
  const permissions = workbench.page.getByRole('dialog', { name: 'Extension Permissions', exact: true });
  const show = async () => {
    await workbench.page.getByRole('button', { name: 'Extensions', exact: true }).click();
    await permissions.getByRole('heading', { name: 'Broker Test' }).waitFor();
  };
  const activate = async () => {
    await show();
    await permissions.getByRole('button', { name: 'Review Permissions', exact: true }).click();
    await permissions.getByText('Active for this session', { exact: true }).waitFor();
  };
  const command = async (draft = false) => {
    await permissions.getByRole('button', { name: draft ? 'Run Review draft answer' : 'Run Review saved answer', exact: true }).click();
    await permissions.getByRole('button', { name: 'Review Edit', exact: true }).waitFor().catch(async error => {
      const audit = await fs.readFile(path.join(workbench.profile, 'extensions', 'audit.json'), 'utf8');
      const events = JSON.parse(audit).events.map(event => [event.operation, event.result, event.code]);
      throw new Error('Extension command failed. ' + await workbench.page.locator('#extension-permissions-status').textContent() +
        ' Audit ' + JSON.stringify(events), { cause: error });
    });
  };
  return { ...workbench, permissions, show, activate, command, extensionId: manifest.id, digest };
}

test('the Wasm broker import rejects invalid guest memory before accessing the trusted handler',
  { timeout: 25_000 }, async t => {
    const scratch = await temporaryFolder(t, 'cevra-broker-memory-');
    let calls = 0;
    const host = await openIsolationLab(scratch, { onRequest: async () => {
      calls++;
      return Buffer.from('{"ok":true,"result":{"registrationId":"test"}}');
    } });
    t.after(() => host.stop());
    await host.activate(await fs.readFile(path.join(artifacts, 'broker-fixture.wasm')));
    assert.equal(calls, 3);
    await assert.rejects(host.invoke(2), { code: 'HOST_COMMAND' });
    assert.equal(calls, 3);
    await assertWindowsProcessStopped(host.pid);
    assert.deepEqual(await fs.readdir(scratch), []);
  });

test('the broker host rejects WASI imports before any broker request', { timeout: 25_000 }, async t => {
  const scratch = await temporaryFolder(t, 'cevra-broker-imports-');
  let calls = 0;
  const host = await openIsolationLab(scratch, { onRequest: async () => { calls++; return Buffer.from('{}'); } });
  t.after(() => host.stop());
  const library = Buffer.from('wasi_snapshot_preview1');
  const field = Buffer.from('fd_write');
  const imports = Buffer.from([1, library.length, ...library, field.length, ...field, 0, 0]);
  const module = Buffer.concat([Buffer.from('0061736d01000000010401600000', 'hex'), Buffer.of(2, imports.length), imports]);
  await assert.rejects(host.activate(module), { code: 'HOST_ACTIVATION' });
  assert.equal(calls, 0);
  await assertWindowsProcessStopped(host.pid);
  assert.deepEqual(await fs.readdir(scratch), []);
});

test('a real confined extension requires consent, navigates diagnostics and applies a reviewed edit as an undoable draft',
  { timeout: 45_000 }, async t => {
    const workbench = await runtimeWorkbench(t);
    const { page, permissions, project, editor, app } = workbench;
    await workbench.open('entry.js');
    await workbench.activate();
    const reviews = await app.evaluate(() => globalThis.extensionReviews);
    assert.deepEqual(reviews.map(review => review.title), ['Workspace trust', 'Extension permissions']);
    assert.ok(reviews.every(review => review.defaultId === 0));
    assert.ok(reviews[1].detail.includes(workbench.digest));
    assert.ok(reviews[1].detail.includes(relative));
    const checkSelection = permissions.getByRole('button', { name: 'Run Check active selection', exact: true });
    await checkSelection.click();
    await permissions.getByText('Command completed.', { exact: true }).waitFor();
    await workbench.command();
    await permissions.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('#show-problems').click();
    await page.getByRole('button', { name: /Warning.*Check answer/ }).click();
    await workbench.selected('value.js').waitFor();
    assert.match(await page.locator('#cursor').textContent(), /Ln 1/);
    await editor.press('Control+Home');
    for (let index = 0; index < 6; index++) await editor.press('ArrowRight');
    for (let index = 0; index < 6; index++) await editor.press('Shift+ArrowRight');
    await workbench.show();
    await checkSelection.click();
    await permissions.getByText('Command completed.', { exact: true }).waitFor();
    await permissions.getByRole('button', { name: 'Review Edit', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'Review Extension Edit', exact: true });
    await preview.getByRole('button', { name: 'Apply as Drafts', exact: true }).waitFor({ state: 'visible' });
    await preview.locator('ins').getByText('const answer = 42;', { exact: false }).waitFor();
    await preview.getByRole('button', { name: 'Apply as Drafts', exact: true }).click();
    await preview.waitFor({ state: 'hidden' });
    await page.locator('#draft-status[data-state="saved"]').waitFor();
    assert.deepEqual(await editor.locator('.cm-line').allTextContents(), proposed.split('\n'));
    assert.equal(await fs.readFile(path.join(project, relative), 'utf8'), original);
    await editor.press('Control+z');
    assert.deepEqual(await editor.locator('.cm-line').allTextContents(), original.split('\n'));
    const dirty = 'const answer = 19;\n';
    await replaceEditor(workbench, dirty);
    await workbench.show();
    await workbench.command(true);
    await permissions.getByRole('button', { name: 'Review Edit', exact: true }).click();
    await preview.locator('del').getByText('const answer = 19;', { exact: false }).waitFor();
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(await editor.locator('.cm-line').allTextContents(), dirty.split('\n'));
    await replaceEditor(workbench, 'const answer = 20;\n');
    await workbench.show();
    assert.equal(await permissions.getByRole('button', { name: 'Review Edit', exact: true }).count(), 0);
    await permissions.getByRole('button', { name: 'Revoke Access', exact: true }).click();
    await permissions.getByRole('button', { name: 'Review Permissions', exact: true }).waitFor();
    assert.equal(await permissions.getByRole('button', { name: 'Run Review saved answer', exact: true }).count(), 0);
    const audit = await fs.readFile(path.join(workbench.profile, 'extensions', 'audit.json'), 'utf8');
    for (const value of [original.trim(), project, relative, 'PRIVATE_SOURCE_MARKER']) assert.ok(!audit.includes(value));
    assert.ok(JSON.parse(audit).events.some(event => event.operation === 'workspace.readFile' && event.result === 'denied'));
    const selections = JSON.parse(audit).events.filter(event => event.operation === 'editor.readSelection');
    assert.equal(selections.at(-1).result, 'allowed');
    assert.ok(selections.some(event => event.result === 'denied'));
  });

test('extension consent can be canceled and safe start and restart require fresh activation',
  { timeout: 45_000 }, async t => {
    let workbench = await runtimeWorkbench(t);
    await workbench.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (_owner, options) => ({ response: options.title === 'Extension permissions' ? 0 : 1 });
    });
    await workbench.show();
    await workbench.permissions.getByRole('button', { name: 'Review Permissions', exact: true }).click();
    await workbench.permissions.getByText('Activation canceled.', { exact: true }).waitFor();
    assert.equal(await workbench.permissions.getByRole('button', { name: 'Run Review saved answer', exact: true }).count(), 0);
    await workbench.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await workbench.permissions.getByRole('button', { name: 'Review Permissions', exact: true }).click();
    await workbench.permissions.getByText('Active for this session', { exact: true }).waitFor();
    await workbench.permissions.getByRole('button', { name: 'Close', exact: true }).click();
    await workbench.open('entry.js');
    await replaceEditor(workbench, 'const entry = "recover";');
    workbench = await workbench.restart({ crash: true });
    await workbench.selected('entry.js').waitFor();
    await workbench.page.getByRole('button', { name: 'Extensions', exact: true }).click();
    await workbench.page.getByRole('button', { name: 'Review Permissions', exact: true }).waitFor();
    assert.equal(await workbench.page.getByRole('button', { name: 'Run Review saved answer', exact: true }).count(), 0);
    await workbench.page.getByRole('dialog', { name: 'Extension Permissions', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    workbench = await workbench.restart({ args: ['--disable-extensions'] });
    await workbench.selected('entry.js').waitFor();
    await workbench.page.getByRole('button', { name: 'Extensions', exact: true }).click();
    const activate = workbench.page.getByRole('button', { name: 'Review Permissions', exact: true });
    await activate.waitFor();
    assert.equal(await activate.isDisabled(), true);
    assert.match(await workbench.editor.textContent(), /recover/);
  });

test('source changes or live disable after extension preview prevent applying the reviewed edit',
  { timeout: 55_000 }, async t => {
    for (const change of ['disk', 'disable']) {
      await t.test(change, async t => {
        const workbench = await runtimeWorkbench(t);
        await workbench.activate();
        await workbench.command();
        await workbench.permissions.getByRole('button', { name: 'Review Edit', exact: true }).click();
        const preview = workbench.page.getByRole('dialog', { name: 'Review Extension Edit', exact: true });
        const apply = preview.getByRole('button', { name: 'Apply as Drafts', exact: true });
        await preview.locator('ins').waitFor();
        if (change === 'disk') await fs.writeFile(path.join(workbench.project, relative), 'external change\n');
        else await workbench.app.evaluate(({ app }, { id, digest }) => {
          const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
          return require('./src/extensions/registry.cjs').createExtensionRegistry(app.getPath('userData')).setEnabled(id, digest, false);
        }, { id: workbench.extensionId, digest: workbench.digest });
        await apply.click();
        await preview.locator('#edits-status').getByText(/source changed|session expired|extension.*expired|unavailable/i).waitFor();
        assert.equal(await fs.readFile(path.join(workbench.project, relative), 'utf8'), change === 'disk' ? 'external change\n' : original);
        const draftFolder = path.join(workbench.profile, 'drafts');
        const drafts = await fs.readdir(draftFolder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        assert.equal(drafts.filter(name => name.endsWith('.json')).length, 0);
      });
    }
  });
