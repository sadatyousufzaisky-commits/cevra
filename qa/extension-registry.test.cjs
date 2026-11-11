const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { inspectExtensionPackage, sha256 } = require('../src/extensions/inspect-package.cjs');
const { createExtensionRegistry } = require('../src/extensions/registry.cjs');
const { archive, json, manifest } = require('./extension-fixtures.cjs');
const { temporaryFolder } = require('./temp.cjs');

const defaultId = 'org.cevra.hello';
const checkpointChild = path.join(__dirname, 'extension-registry-child.cjs');

async function fixture(t) {
  const root = await temporaryFolder(t, 'cevra-registry-');
  const profile = path.join(root, 'profile (QA) & café [#%]');
  const workspace = path.join(root, 'workspace');
  const folder = path.join(profile, 'extensions');
  const file = path.join(folder, 'registry.json');
  await fs.mkdir(profile);
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'draft.txt'), 'draft baseline');
  let sequence = 0;
  async function pack(version = '1.0.0', id = defaultId) {
    const filename = path.join(root, 'package #' + ++sequence + '.zip');
    await fs.writeFile(filename, archive({ ...manifest(), id, version }));
    const { sha256 } = await inspectExtensionPackage(filename);
    return { filename, id, sha256, version };
  }
  const registry = createExtensionRegistry(profile);
  return { root, profile, workspace, folder, file, registry, pack };
}

function install(registry, pack, expectedCurrent) {
  return registry.install(pack.filename, { reviewedDigest: pack.sha256, expectedCurrent });
}

function signedSnapshot(data) {
  return json({ data, checksum: sha256(json(data)) });
}

async function interrupt(profile, operation, stage, args) {
  const child = fork(checkpointChild, [profile, operation, stage, JSON.stringify(args)], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  const ready = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', () => reject(new Error('The registry process exited before ' + stage + '.')));
    child.once('error', reject);
  });
  let deadline;
  try {
    const result = await Promise.race([ready, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Timed out waiting for ' + stage + '.')), 8000);
    })]);
    assert.deepEqual(result, { stage });
  } finally {
    clearTimeout(deadline);
    child.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
  }
}

test('registry install, enable, update, rollback and removal persist exact digests and state', async t => {
  const { registry, profile, pack, file, workspace } = await fixture(t);
  assert.deepEqual(await registry.list(), []);
  const first = await pack();
  const second = await pack('2.0.0');
  const installed = await install(registry, first);
  assert.equal(installed.state, 'disabled');
  assert.equal(installed.rollback, null);
  const original = await fs.readFile(file);
  assert.deepEqual(await install(registry, first), installed);
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal((await registry.setEnabled(first.id, first.sha256, true)).state, 'enabled');

  const reopened = createExtensionRegistry(profile);
  assert.equal((await reopened.list())[0].enabled, true);
  const disabled = await reopened.setEnabled(first.id, first.sha256, false);
  assert.equal(disabled.state, 'disabled');
  assert.deepEqual(await reopened.setEnabled(first.id, first.sha256, false), disabled);
  assert.equal((await createExtensionRegistry(profile).list())[0].enabled, false);
  await reopened.setEnabled(first.id, first.sha256, true);
  await assert.rejects(install(reopened, second), { code: 'STALE_REGISTRY' });
  const updated = await install(reopened, second, first.sha256);
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.rollback, { version: first.version, sha256: first.sha256 });
  assert.deepEqual(await install(reopened, second, first.sha256), updated);
  await assert.rejects(reopened.remove(first.id, first.sha256), { code: 'STALE_REGISTRY' });
  assert.equal((await reopened.rollback(second.id, second.sha256)).sha256, first.sha256);
  assert.equal((await reopened.list())[0].state, 'disabled');
  assert.equal(await reopened.remove(first.id, first.sha256), true);
  assert.equal(await reopened.remove(first.id, first.sha256), false);
  assert.deepEqual(await createExtensionRegistry(profile).list(), []);
  assert.deepEqual(JSON.parse(await fs.readFile(file)).data.archives, {});
  assert.deepEqual(await fs.readdir(workspace), ['draft.txt']);
  assert.equal(await fs.readFile(path.join(workspace, 'draft.txt'), 'utf8'), 'draft baseline');
});

test('registry rejects changed review bytes, preserves quarantine, and drops retired archives', async t => {
  const { registry, pack, file } = await fixture(t);
  const first = await pack();
  const second = await pack('2.0.0');
  const third = await pack('3.0.0');
  await assert.rejects(registry.install(second.filename, { reviewedDigest: first.sha256 }), { code: 'REVIEW_CHANGED' });
  assert.deepEqual(await registry.list(), []);
  await install(registry, first);
  await registry.setEnabled(first.id, first.sha256, true);
  assert.equal((await registry.quarantine(first.id, first.sha256)).state, 'quarantined');
  await assert.rejects(registry.setEnabled(first.id, first.sha256, true), { code: 'EXTENSION_QUARANTINED' });
  await install(registry, second, first.sha256);
  assert.equal((await registry.rollback(second.id, second.sha256)).state, 'quarantined');
  await install(registry, third, first.sha256);
  const snapshot = JSON.parse(await fs.readFile(file)).data;
  assert.deepEqual(Object.keys(snapshot.archives).sort(), [first.sha256, third.sha256].sort());
});

test('registry serializes clients in one process and orders independent packages deterministically', async t => {
  const { registry, profile, pack } = await fixture(t);
  const secondClient = createExtensionRegistry(profile);
  const first = await pack('1.0.0', 'org.cevra.zulu');
  const second = await pack('1.0.0', 'org.cevra.alpha');
  await Promise.all([install(registry, first), install(secondClient, second)]);
  assert.deepEqual((await registry.list()).map(entry => entry.id), [second.id, first.id]);
  const updates = [await pack('2.0.0', first.id), await pack('3.0.0', first.id)];
  const results = await Promise.allSettled(updates.map((item, index) => install(index ? registry : secondClient, item, first.sha256)));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'STALE_REGISTRY');
  assert.equal((await registry.list()).find(entry => entry.id === first.id).sha256,
    results.find(item => item.status === 'fulfilled').value.sha256);
});

test('registry reports damaged package bytes and restores the verified rollback candidate', async t => {
  const { registry, pack, file } = await fixture(t);
  const first = await pack();
  const second = await pack('2.0.0');
  await install(registry, first);
  await install(registry, second, first.sha256);
  await registry.setEnabled(second.id, second.sha256, true);
  assert.deepEqual((await registry.contributions()).map(entry => entry.sha256), [second.sha256]);
  const { data } = JSON.parse(await fs.readFile(file));
  data.archives[second.sha256] = data.archives[first.sha256];
  await fs.writeFile(file, signedSnapshot(data));
  const [damaged] = await registry.list();
  assert.equal(damaged.state, 'failed');
  assert.equal(damaged.enabled, false);
  assert.equal(damaged.failure, 'STORED_PACKAGE_CHANGED');
  assert.deepEqual(await registry.contributions(), []);
  await assert.rejects(registry.setEnabled(second.id, second.sha256, true), { code: 'STORED_PACKAGE_CHANGED' });
  assert.equal((await registry.rollback(second.id, second.sha256)).sha256, first.sha256);
  await assert.rejects(registry.rollback(first.id, first.sha256), { code: 'STORED_PACKAGE_CHANGED' });
});

test('registry preserves corrupt snapshots and refuses a linked store directory', async t => {
  const { registry, profile, pack, file, workspace, folder } = await fixture(t);
  const first = await pack();
  await install(registry, first);
  const snapshot = Buffer.concat([await fs.readFile(file), Buffer.from(' ')]);
  await fs.writeFile(file, snapshot);
  await assert.rejects(registry.list(), { code: 'REGISTRY_CORRUPT' });
  await assert.rejects(registry.contributions(), { code: 'REGISTRY_CORRUPT' });
  await assert.rejects(install(registry, first), { code: 'REGISTRY_CORRUPT' });
  assert.deepEqual(await fs.readFile(file), snapshot);
  await fs.rename(folder, path.join(profile, 'original'));
  await fs.symlink(workspace, folder, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(install(registry, first), { code: 'REGISTRY_PATH' });
  assert.deepEqual(await fs.readdir(workspace), ['draft.txt']);
});

test('contributions use committed enabled digests and notify only observers of the same profile', async t => {
  const { registry, profile, workspace, pack } = await fixture(t);
  const first = await pack();
  const second = await pack('2.0.0');
  const changes = [];
  let unrelatedChanges = 0;
  const unsubscribe = registry.onChange(id => changes.push(id));
  t.after(unsubscribe);
  t.after(createExtensionRegistry(workspace).onChange(() => unrelatedChanges++));
  const writer = createExtensionRegistry(profile);
  await install(writer, first);
  assert.deepEqual(await registry.contributions(), []);
  await writer.setEnabled(first.id, first.sha256, true);
  const expected = [{ id: first.id, sha256: first.sha256, snippets: manifest().contributes.snippets, palettes: [] }];
  assert.deepEqual(await registry.contributions(), expected);
  await writer.setEnabled(first.id, first.sha256, true);
  await assert.rejects(install(writer, second), { code: 'STALE_REGISTRY' });
  assert.deepEqual(changes, [first.id, first.id]);

  await install(writer, second, first.sha256);
  assert.deepEqual(await registry.contributions(), []);
  await writer.rollback(second.id, second.sha256);
  assert.deepEqual(await registry.contributions(), []);
  await writer.setEnabled(first.id, first.sha256, true);
  assert.deepEqual(await registry.contributions(), expected);
  await writer.quarantine(first.id, first.sha256);
  assert.deepEqual(await registry.contributions(), []);
  await writer.remove(first.id, first.sha256);
  assert.deepEqual(await registry.contributions(), []);
  assert.deepEqual(changes, Array(7).fill(first.id));
  assert.equal(unrelatedChanges, 0);
  unsubscribe();
  await install(writer, first);
  assert.equal(changes.length, 7);
});

test('registry enforces the installed extension count quota before replacing the snapshot', async t => {
  const { registry, pack, file } = await fixture(t);
  for (let index = 0; index < 64; index++) await install(registry, await pack('1.0.0', 'org.cevra.ext-' + index));
  const before = await fs.readFile(file);
  await assert.rejects(install(registry, await pack('1.0.0', 'org.cevra.overflow')), { code: 'REGISTRY_QUOTA' });
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await registry.list()).length, 64);
});

test('registry counts current and rollback archives against the shared byte quota', async t => {
  const { registry, file, root } = await fixture(t);
  await registry.list();
  const data = { version: 1, entries: [], archives: {} };
  const largePackage = (id, version) => {
    const bytes = Buffer.alloc(128 * 1024, 0x20);
    json({ ...manifest(), id, version }).copy(bytes);
    return archive(bytes);
  };
  const addVersion = (id, version) => {
    const bytes = largePackage(id, version);
    const digest = sha256(bytes);
    data.archives[digest] = bytes.toString('base64');
    return { sha256: digest, version, quarantined: false };
  };
  for (let index = 0; index < 64; index++) {
    const id = 'org.cevra.large-' + String(index).padStart(2, '0');
    data.entries.push({
      id, enabled: false, current: addVersion(id, '2.0.0'),
      previous: index === 63 ? null : addVersion(id, '1.0.0'),
    });
  }
  const before = signedSnapshot(data);
  await fs.writeFile(file, before);
  const last = data.entries.at(-1);
  const candidate = path.join(root, 'large.zip');
  const bytes = largePackage(last.id, '3.0.0');
  await fs.writeFile(candidate, bytes);
  await assert.rejects(registry.install(candidate, { reviewedDigest: sha256(bytes), expectedCurrent: last.current.sha256 }),
    { code: 'REGISTRY_QUOTA' });
  assert.deepEqual(await fs.readFile(file), before);
});

for (const action of ['install', 'update', 'remove']) {
  test('registry recovers after terminating a real process at every ' + action + ' checkpoint', { timeout: 45_000 }, async t => {
    for (const stage of ['prepared', 'partial', 'staged', 'committed']) {
      const { profile, registry, pack, folder, workspace } = await fixture(t);
      const first = await pack();
      const second = await pack('2.0.0');
      if (action !== 'install') await install(registry, first);
      const operation = action === 'remove' ? 'remove' : 'install';
      const args = action === 'remove' ? [first.id, first.sha256] : action === 'update' ?
        [second.filename, { reviewedDigest: second.sha256, expectedCurrent: first.sha256 }] :
        [first.filename, { reviewedDigest: first.sha256 }];
      await interrupt(profile, operation, stage, args);
      const recovered = createExtensionRegistry(profile);
      const expected = stage !== 'committed' ? (action === 'install' ? [] : [first.sha256]) :
        action === 'remove' ? [] : action === 'update' ? [second.sha256] : [first.sha256];
      assert.deepEqual((await recovered.list()).map(entry => entry.sha256), expected, stage);
      assert.ok((await fs.readdir(folder)).every(name => name === 'registry.json'), stage);
      assert.deepEqual(await fs.readdir(workspace), ['draft.txt']);
      await recovered[operation](...args);
      const final = await recovered.list();
      assert.deepEqual(final.map(entry => entry.sha256),
        action === 'remove' ? [] : [action === 'update' ? second.sha256 : first.sha256]);
      if (action === 'update') assert.equal(final[0].rollback.sha256, first.sha256);
    }
  });
}
