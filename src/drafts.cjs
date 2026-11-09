const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeAtomic } = require('./atomic-file.cjs');

const version = 1;
const revisionPattern = /^[a-f0-9]{64}$/;

function createDraftStore(folder) {
  const journal = path.join(folder, 'batch.json');
  let pending = Promise.resolve();
  const filename = (root, relative) => createHash('sha256').update(root + '\0' + relative).digest('hex') + '.json';

  function enqueue(action) {
    const operation = pending.then(action);
    pending = operation.catch(() => {});
    return operation;
  }

  function validate(draft) {
    if (draft?.version !== version || typeof draft.root !== 'string' || !path.isAbsolute(draft.root) ||
        typeof draft.path !== 'string' || typeof draft.text !== 'string' ||
        !revisionPattern.test(draft.revision) || !Number.isFinite(draft.updated)) throw new Error('Invalid draft.');
    return filename(draft.root, draft.path);
  }

  async function readBatch() {
    try {
      const entries = JSON.parse(await fs.readFile(journal, 'utf8'));
      if (!Array.isArray(entries) || !entries.length || new Set(entries.map(validate)).size !== entries.length) {
        throw new Error('Invalid draft batch.');
      }
      return entries;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function writeDraft(draft) {
    await writeAtomic(path.join(folder, validate(draft)), JSON.stringify(draft));
  }

  async function replay(entries) {
    if (!entries.length) return;
    for (const draft of entries) await writeDraft(draft);
    await fs.rm(journal);
  }

  function set(root, relative, text, revision) {
    return enqueue(async () => {
      await replay(await readBatch());
      if (text === null) {
        await fs.rm(path.join(folder, filename(root, relative)), { force: true });
        return;
      }
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      await writeDraft({ version, root, path: relative, text, revision, updated: Date.now() });
    });
  }

  function setMany(root, changes) {
    return enqueue(async () => {
      const updated = Date.now();
      const entries = changes.map(({ path, text, revision }) => ({ version, root, path, text, revision, updated }));
      if (!entries.length || new Set(entries.map(validate)).size !== entries.length) throw new Error('Invalid draft batch.');
      await replay(await readBatch());
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      await writeAtomic(journal, JSON.stringify(entries));
      // The journal is authoritative until every individual draft has been written.
      await replay(entries).catch(() => {});
    });
  }

  async function readEntries() {
    let names;
    try {
      names = await fs.readdir(folder);
    } catch (error) {
      if (error.code === 'ENOENT') return { entries: [], unreadable: false };
      throw error;
    }
    const entries = new Map();
    let unreadable = false;
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const draft = JSON.parse(await fs.readFile(path.join(folder, name), 'utf8'));
        if (validate(draft) !== name) throw new Error('Invalid draft.');
        entries.set(name, draft);
      } catch {
        unreadable = true;
      }
    }
    try {
      for (const draft of await readBatch()) entries.set(validate(draft), draft);
    } catch {
      unreadable = true;
    }
    return { entries: [...entries.values()].sort((a, b) => b.updated - a.updated), unreadable };
  }

  function clear(root) {
    return enqueue(async () => {
      await replay(await readBatch());
      const { entries } = await readEntries();
      for (const draft of entries) {
        if (draft.root === root) await fs.rm(path.join(folder, filename(root, draft.path)), { force: true });
      }
    });
  }

  return { set, setMany, list: () => enqueue(readEntries), clear };
}

module.exports = { createDraftStore };
