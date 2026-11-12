const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { createConnectionManager } = require('../src/intelligence/connection-manager.cjs');
const { temporaryFolder } = require('./temp.cjs');

const provider = 'openai';
const fileAt = profile => path.join(profile, 'intelligence', 'connections.json');
const read = async profile => JSON.parse(await fs.readFile(fileAt(profile), 'utf8'));
const status = async manager => (await manager.list()).find(entry => entry.providerId === provider).state;

async function fixture(t) {
  const profile = await temporaryFolder(t, 'cevra-connections-');
  const keys = new Set();
  const calls = [];
  const vault = {
    available: () => true,
    async prompt(scope, provider, reference) {
      calls.push(['prompt', scope, provider, reference]);
      keys.add(reference);
      return 'ok';
    },
    async inspect(scope, provider, reference) {
      calls.push(['inspect', scope, provider, reference]);
      return keys.has(reference) ? 'ok' : 'missing';
    },
    async remove(scope, provider, reference) {
      calls.push(['remove', scope, provider, reference]);
      keys.delete(reference);
      return 'ok';
    },
  };
  return { profile, keys, calls, vault, manager: createConnectionManager(profile, vault) };
}

test('connections expose only provider status, with an explicit check and persistent nonsecret metadata', async t => {
  const { profile, calls, manager, vault } = await fixture(t);
  assert.equal(await status(manager), 'unconfigured');
  assert.deepEqual(calls, []);
  await assert.rejects(fs.stat(fileAt(profile)), { code: 'ENOENT' });
  assert.throws(() => manager.store('provider.example', {}), { code: 'INVALID_CONNECTION' });
  assert.equal(await manager.store(provider, {}), 'stored');
  const reopened = createConnectionManager(profile, vault);
  const entry = (await read(profile)).entries[0];
  assert.deepEqual(Object.keys(entry), ['providerId', 'current', 'pending', 'cleanup']);
  assert.deepEqual((await reopened.list()).find(item => item.providerId === provider), {
    providerId: provider, label: 'OpenAI', state: 'configured',
  });
  assert.equal(calls.length, 1);
  assert.equal(await reopened.check(provider), 'available');
  assert.deepEqual(calls.at(-1), ['inspect', calls[0][1], provider, entry.current]);
});

test('canceling a staged rotation preserves the old key and a committed rotation removes it', async t => {
  const { profile, manager, vault, keys } = await fixture(t);
  await manager.store(provider, {});
  const first = (await read(profile)).entries[0].current;
  const prompt = vault.prompt;
  vault.prompt = async (...args) => { await prompt(...args); return 'cancelled'; };
  assert.equal(await manager.store(provider, {}), 'cancelled');
  assert.deepEqual([...keys], [first]);
  assert.equal((await read(profile)).entries[0].current, first);
  vault.prompt = prompt;
  assert.equal(await manager.store(provider, {}), 'rotated');
  const second = (await read(profile)).entries[0].current;
  assert.notEqual(second, first);
  assert.deepEqual([...keys], [second]);
  await manager.disconnect(provider);
  assert.deepEqual([...keys], []);
  assert.deepEqual((await read(profile)).entries, []);
  await manager.disconnect(provider);
});

test('owner cancellation cleans a late native write and concurrent operations cannot change its pending slot', async t => {
  const { profile, manager, vault, keys } = await fixture(t);
  const begun = Promise.withResolvers();
  const complete = Promise.withResolvers();
  const write = vault.prompt;
  vault.prompt = async (...args) => {
    begun.resolve();
    await complete.promise;
    return write(...args);
  };
  const controller = new AbortController();
  const pending = manager.store(provider, {}, controller.signal);
  await begun.promise;
  await assert.rejects(manager.list(), { code: 'VAULT_BUSY' });
  await assert.rejects(manager.disconnect(provider), { code: 'VAULT_BUSY' });
  controller.abort();
  complete.resolve();
  assert.equal(await pending, 'cancelled');
  assert.deepEqual((await read(profile)).entries, []);
  assert.equal(keys.size, 0);
});

test('a failed rotation commit leaves a recoverable pending marker and blocks checks until cleanup', async t => {
  const { profile, manager, vault, keys } = await fixture(t);
  await manager.store(provider, {});
  const first = (await read(profile)).entries[0].current;
  let writes = 0;
  const rename = fs.rename;
  const patch = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === fileAt(profile) && ++writes === 2) throw new Error('SYNTHETIC COMMIT FAILURE');
    return rename(from, to);
  });
  await assert.rejects(manager.store(provider, {}), { code: 'CONNECTION_STORE' });
  patch.mock.restore();
  const pending = (await read(profile)).entries[0];
  assert.equal(pending.current, first);
  assert.ok(keys.has(pending.pending));
  const reopened = createConnectionManager(profile, vault);
  assert.equal(await status(reopened), 'cleanup-required');
  await assert.rejects(reopened.check(provider), { code: 'CLEANUP_REQUIRED' });
  await reopened.cleanup(provider);
  assert.deepEqual([...keys], [first]);
  assert.equal(await reopened.check(provider), 'available');
});

test('failed deletion persists a disabled cleanup record across restart and retry removes the key', async t => {
  const { profile, manager, vault, keys } = await fixture(t);
  await manager.store(provider, {});
  const first = (await read(profile)).entries[0].current;
  const remove = vault.remove;
  vault.remove = async () => 'unavailable';
  await assert.rejects(manager.disconnect(provider), { code: 'CLEANUP_REQUIRED' });
  assert.deepEqual((await read(profile)).entries[0], { providerId: provider, current: null, pending: null, cleanup: [first] });
  const reopened = createConnectionManager(profile, vault);
  await assert.rejects(reopened.check(provider), { code: 'CLEANUP_REQUIRED' });
  vault.remove = remove;
  await reopened.cleanup(provider);
  assert.equal(keys.size, 0);
  assert.equal(await status(reopened), 'unconfigured');
});

test('rotated keys stay unusable until retired entries are removed and missing entries report distinctly', async t => {
  const { profile, manager, vault, keys } = await fixture(t);
  await manager.store(provider, {});
  const first = (await read(profile)).entries[0].current;
  const remove = vault.remove;
  vault.remove = async () => 'unavailable';
  await assert.rejects(manager.store(provider, {}), { code: 'CLEANUP_REQUIRED' });
  const second = (await read(profile)).entries[0].current;
  assert.notEqual(first, second);
  await assert.rejects(manager.check(provider), { code: 'CLEANUP_REQUIRED' });
  vault.remove = remove;
  await manager.cleanup(provider);
  assert.deepEqual([...keys], [second]);
  keys.delete(second);
  assert.equal(await manager.check(provider), 'missing');
  await manager.disconnect(provider);
});

test('damaged and linked metadata fail closed without accessing the credential vault', async t => {
  const { profile, calls, manager } = await fixture(t);
  await fs.mkdir(path.dirname(fileAt(profile)));
  for (const metadata of [
    '{',
    '{"schemaVersion":1,"schemaVersion":1,"entries":[]}',
    JSON.stringify({ schemaVersion: 1, entries: [{ providerId: provider, current: 'arbitrary', pending: null, cleanup: [] }] }),
    JSON.stringify({ schemaVersion: 1, entries: [{ providerId: provider, current: randomUUID(), pending: null, cleanup: [], apiKey: 'fixture' }] }),
    'x'.repeat(9000),
  ]) {
    await fs.writeFile(fileAt(profile), metadata);
    await assert.rejects(manager.check(provider), { code: 'CONNECTION_STORE' });
  }
  assert.deepEqual(calls, []);
  const separate = await temporaryFolder(t, 'cevra-linked-connections-');
  const target = await temporaryFolder(t, 'cevra-connection-target-');
  await fs.symlink(target, path.join(separate, 'intelligence'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = createConnectionManager(separate, { available: () => true });
  await assert.rejects(linked.list(), { code: 'CONNECTION_STORE' });
});
