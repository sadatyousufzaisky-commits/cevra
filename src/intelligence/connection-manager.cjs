const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { writeAtomic } = require('../atomic-file.cjs');
const { readCheckedFile } = require('../extensions/inspect-package.cjs');
const { exactRecord } = require('./provider-contract.cjs');

const providers = Object.freeze({ openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' });
const referencePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const maxBytes = 8192;
const messages = Object.freeze({
  INVALID_CONNECTION: 'Choose a supported provider.',
  VAULT_BUSY: 'A connection operation is already in progress.',
  VAULT_UNAVAILABLE: 'Windows Credential Manager is unavailable.',
  CONNECTION_STORE: 'Connection metadata is unavailable or damaged.',
  CLEANUP_REQUIRED: 'Remove the interrupted credential entries before continuing.',
  NO_CONNECTION: 'There is no stored key for this provider.',
});

function failure(code) { return Object.assign(new Error(messages[code]), { code }); }
function connectionErrorMessage(error) {
  return typeof error?.code === 'string' && Object.hasOwn(messages, error.code) ? messages[error.code] :
    'The connection operation could not finish.';
}
const validRef = value => typeof value === 'string' && referencePattern.test(value);
const entryRefs = entry => [entry.current, entry.pending, ...entry.cleanup].filter(value => value !== null);
const metadataFile = 'connections.json';

function validMetadata(data) {
  if (!exactRecord(data, ['schemaVersion', 'entries']) || data.schemaVersion !== 1 ||
      !Array.isArray(data.entries) || data.entries.length > Object.keys(providers).length) return false;
  const seen = new Set();
  const refs = new Set();
  for (const entry of data.entries) {
    if (!exactRecord(entry, ['providerId', 'current', 'pending', 'cleanup']) ||
        typeof entry.providerId !== 'string' || !Object.hasOwn(providers, entry.providerId) || seen.has(entry.providerId) ||
        !Array.isArray(entry.cleanup) || entry.cleanup.length > 2 || (entry.pending && entry.cleanup.length)) return false;
    seen.add(entry.providerId);
    const values = entryRefs(entry);
    if (!values.length || values.length > 2 || entry.cleanup.some(value => !validRef(value))) return false;
    for (const reference of values) {
      if (!validRef(reference) || refs.has(reference)) return false;
      refs.add(reference);
    }
  }
  return true;
}

async function checkDirectory(folder) {
  const stat = await fs.lstat(folder, { bigint: true });
  if (!stat.isDirectory() || path.relative(folder, await fs.realpath(folder)) !== '') throw failure('CONNECTION_STORE');
  return stat;
}

async function openMetadata(profile) {
  try {
    const root = await fs.realpath(profile);
    const folder = path.join(root, 'intelligence');
    const file = path.join(folder, metadataFile);
    const scope = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex');
    let stat;
    try { stat = await checkDirectory(folder); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let bytes;
    if (stat) {
      try { bytes = await readCheckedFile(file, maxBytes); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const data = bytes ? JSON.parse(bytes.toString('utf8')) : { schemaVersion: 1, entries: [] };
    if (!validMetadata(data) || (bytes && !Buffer.from(JSON.stringify(data)).equals(bytes))) throw failure('CONNECTION_STORE');
    return {
      scope, data,
      async save(entries) {
        try {
          if (!stat) {
            await fs.mkdir(folder, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
            stat = await checkDirectory(folder);
          }
          const next = { schemaVersion: 1, entries };
          if (!validMetadata(next)) throw failure('CONNECTION_STORE');
          await writeAtomic(file, JSON.stringify(next), {
            beforeCommit: async () => {
              const latest = await checkDirectory(folder);
              if (latest.dev !== stat.dev || latest.ino !== stat.ino || latest.birthtimeNs !== stat.birthtimeNs) {
                throw failure('CONNECTION_STORE');
              }
            },
          });
          data.entries = entries;
        } catch { throw failure('CONNECTION_STORE'); }
      },
    };
  } catch { throw failure('CONNECTION_STORE'); }
}

const entryFor = (store, providerId) => store.data.entries.find(entry => entry.providerId === providerId);
const interrupted = entry => Boolean(entry?.pending || entry?.cleanup.length);
function replace(store, providerId, entry) {
  const remaining = store.data.entries.filter(item => item.providerId !== providerId);
  if (entry && entryRefs(entry).length) remaining.push(entry);
  return store.save(remaining);
}

function createConnectionManager(profile, vault) {
  let busy = false;

  async function run(operation) {
    if (!vault.available()) throw failure('VAULT_UNAVAILABLE');
    if (busy) throw failure('VAULT_BUSY');
    busy = true;
    try { return await operation(await openMetadata(profile)); }
    finally { busy = false; }
  }

  function providerOperation(providerId, operation) {
    if (typeof providerId !== 'string' || !Object.hasOwn(providers, providerId)) throw failure('INVALID_CONNECTION');
    return run(store => operation(store, entryFor(store, providerId)));
  }

  async function clean(store, entry) {
    const { providerId, current, pending, cleanup } = entry;
    const abandoned = pending ? [pending] : cleanup;
    for (const reference of abandoned) {
      if (await vault.remove(store.scope, providerId, reference) !== 'ok') throw failure('CLEANUP_REQUIRED');
    }
    await replace(store, providerId, { providerId, current, pending: null, cleanup: [] });
  }

  return Object.freeze({
    available: () => vault.available(),
    list: () => run(store => Object.entries(providers).map(([providerId, label]) => {
      const entry = entryFor(store, providerId);
      return { providerId, label, state: interrupted(entry) ? 'cleanup-required' : entry?.current ? 'configured' : 'unconfigured' };
    })),
    store(providerId, owner, signal) {
      return providerOperation(providerId, async (store, previous) => {
        if (interrupted(previous)) throw failure('CLEANUP_REQUIRED');
        if (signal?.aborted) return 'cancelled';
        const pending = randomUUID();
        const staged = { providerId, current: previous?.current ?? null, pending, cleanup: [] };
        await replace(store, providerId, staged);
        const outcome = await vault.prompt(store.scope, providerId, pending, owner, signal).catch(() => 'unavailable');
        if (outcome !== 'ok' || signal?.aborted) {
          await clean(store, staged);
          if (outcome === 'cancelled' || signal?.aborted) return 'cancelled';
          throw failure('VAULT_UNAVAILABLE');
        }
        const next = { providerId, current: pending, pending: null, cleanup: staged.current ? [staged.current] : [] };
        await replace(store, providerId, next);
        if (next.cleanup.length) await clean(store, next);
        return staged.current ? 'rotated' : 'stored';
      });
    },
    check(providerId) {
      return providerOperation(providerId, async (store, entry) => {
        if (interrupted(entry)) throw failure('CLEANUP_REQUIRED');
        if (!entry?.current) throw failure('NO_CONNECTION');
        const status = await vault.inspect(store.scope, providerId, entry.current);
        if (status === 'ok') return 'available';
        if (status === 'missing') return 'missing';
        throw failure('VAULT_UNAVAILABLE');
      });
    },
    disconnect(providerId) {
      return providerOperation(providerId, async (store, entry) => {
        if (!entry) return;
        const retired = { providerId, current: null, pending: null, cleanup: entryRefs(entry) };
        await replace(store, providerId, retired);
        await clean(store, retired);
      });
    },
    cleanup(providerId) {
      return providerOperation(providerId, async (store, entry) => {
        if (interrupted(entry)) await clean(store, entry);
      });
    },
  });
}

module.exports = { createConnectionManager, providers, connectionErrorMessage };
