const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeAtomic } = require('./atomic-file.cjs');

const version = 1;
const revisionPattern = /^[a-f0-9]{64}$/;

function createDraftStore(folder) {
  const pending = new Map();
  const filename = (root, relative) => createHash('sha256').update(root + '\0' + relative).digest('hex') + '.json';

  async function set(root, relative, text, revision) {
    const file = path.join(folder, filename(root, relative));
    const previous = pending.get(file) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (text === null) {
        await fs.rm(file, { force: true });
        return;
      }
      if (typeof text !== 'string' || !revisionPattern.test(revision)) throw new Error('Invalid draft.');
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      await writeAtomic(file, JSON.stringify({ version, root, path: relative, text, revision, updated: Date.now() }));
    });
    pending.set(file, operation);
    try {
      await operation;
    } finally {
      if (pending.get(file) === operation) pending.delete(file);
    }
  }

  async function list() {
    await Promise.allSettled([...pending.values()]);
    let names;
    try {
      names = await fs.readdir(folder);
    } catch (error) {
      if (error.code === 'ENOENT') return { entries: [], unreadable: false };
      throw error;
    }
    const entries = [];
    let unreadable = false;
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const draft = JSON.parse(await fs.readFile(path.join(folder, name), 'utf8'));
        if (draft?.version !== version || typeof draft.root !== 'string' || !path.isAbsolute(draft.root) ||
            typeof draft.path !== 'string' || typeof draft.text !== 'string' ||
            !revisionPattern.test(draft.revision) || !Number.isFinite(draft.updated) ||
            filename(draft.root, draft.path) !== name) throw new Error('Invalid draft.');
        entries.push(draft);
      } catch {
        unreadable = true;
      }
    }
    entries.sort((a, b) => b.updated - a.updated);
    return { entries, unreadable };
  }

  async function clear(root) {
    const { entries } = await list();
    for (const draft of entries) {
      if (draft.root === root) await set(root, draft.path, null);
    }
  }

  return { set, list, clear };
}

module.exports = { createDraftStore };
