const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { writeAtomic } = require('../atomic-file.cjs');
const { isTaskId } = require('./task-plan.cjs');

const limit = 64;
const maxBytes = 64 * 1024;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const revision = /^[a-f0-9]{64}$/;
const outcomes = new Set(['passed', 'failed', 'empty', 'cancelled']);
const freshness = new Set(['observed', 'historical', 'unavailable']);

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function workstreamKey(workspace) {
  const { dev, ino, birthtimeNs } = workspace.identity;
  const root = process.platform === 'win32' ? workspace.root.toLowerCase() : workspace.root;
  return digest([root, String(dev), String(ino), String(birthtimeNs)]);
}

function validCapsule(value, workstreamId, version) {
  const task = version === 2 && value?.kind === 'task';
  return value && Object.keys(value).length === (task ? 11 : 10) && typeof value.id === 'string' && uuid.test(value.id) &&
    value.workstreamId === workstreamId && (task ? isTaskId(value.taskId) && !value.retry : value.kind === 'test') &&
    (outcomes.has(value.outcome) || (task && value.outcome === 'blocked')) &&
    freshness.has(value.freshness) && typeof value.retry === 'boolean' &&
    (value.revision === null ? value.freshness === 'unavailable' :
      typeof value.revision === 'string' && revision.test(value.revision)) &&
    (value.exitCode === null || Number.isSafeInteger(value.exitCode)) &&
    Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 &&
    Number.isSafeInteger(value.completedAt) && value.completedAt > 0 && value.completedAt <= 8.64e15 &&
    (value.outcome !== 'passed' || value.exitCode === 0) &&
    (!['cancelled', 'blocked'].includes(value.outcome) || value.freshness === 'unavailable');
}

function createFlightpathStore(root) {
  let pending = Promise.resolve();

  function enqueue(action) {
    const operation = pending.then(action);
    pending = operation.catch(() => {});
    return operation;
  }

  function forWorkspace(workspace) {
    const workstreamId = workstreamKey(workspace);
    const directory = path.join(root, workstreamId);
    const file = path.join(directory, 'journal.json');
    let writeFailed = false;

    async function read() {
      let handle;
      try { handle = await fs.open(file, 'r'); }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid Flightpath size.');
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length !== stat.size) throw new Error('Flightpath changed while reading.');
        const { data, checksum } = JSON.parse(buffer.toString('utf8', 0, length));
        if (![1, 2].includes(data?.version) || Object.keys(data).length !== 4 || data.workstreamId !== workstreamId ||
            typeof data.generation !== 'string' || !uuid.test(data.generation) || !Array.isArray(data.capsules) ||
            data.capsules.length > limit || checksum !== digest(data) ||
            !data.capsules.every(capsule => validCapsule(capsule, workstreamId, data.version)) ||
            new Set(data.capsules.map(capsule => capsule.id)).size !== data.capsules.length) {
          throw new Error('Invalid Flightpath journal.');
        }
        return data;
      } finally { await handle.close(); }
    }

    async function write(data) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await writeAtomic(file, JSON.stringify({ data, checksum: digest(data) }));
      writeFailed = false;
    }

    async function removeInterruptedWrites() {
      let entries;
      try { entries = await fs.opendir(directory); }
      catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for await (const entry of entries) {
        if (/^\.cevra-[a-f0-9-]{36}\.tmp$/.test(entry.name)) {
          await fs.rm(path.join(directory, entry.name), { force: true });
        }
      }
    }

    function snapshot(data) {
      return { enabled: Boolean(data), capsules: data?.capsules ?? [], writeFailed, limit };
    }

    function empty() {
      return { version: 2, workstreamId, generation: randomUUID(), capsules: [] };
    }

    return {
      workstreamId,
      view: () => enqueue(async () => {
        try { return snapshot(await read()); }
        catch { return { ...snapshot(null), unreadable: true }; }
      }),
      enable: () => enqueue(async () => {
        const existing = await read();
        if (existing) return snapshot(existing);
        const data = empty();
        await write(data);
        return snapshot(data);
      }),
      clear: () => enqueue(async () => {
        const existing = await read();
        if (!existing) return snapshot(null);
        await removeInterruptedWrites();
        const data = empty();
        await write(data);
        return snapshot(data);
      }),
      disable: () => enqueue(async () => {
        await removeInterruptedWrites();
        await fs.rm(file, { force: true });
        await fs.rmdir(directory).catch(error => {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
        });
        writeFailed = false;
        return snapshot(null);
      }),
      admit: () => enqueue(async () => (await read())?.generation).catch(() => undefined),
      record(generation, evidence) {
        if (!generation) return;
        const completedAt = Date.now();
        void enqueue(async () => {
          const data = await read();
          if (data?.generation !== generation || data.capsules.some(capsule => capsule.id === evidence.id)) return;
          const kind = evidence.kind ?? 'test';
          const capsule = {
            id: evidence.id, workstreamId, kind, revision: evidence.revision ?? null,
            outcome: evidence.outcome, freshness: evidence.freshness, retry: evidence.retry,
            exitCode: evidence.exitCode ?? null, durationMs: evidence.durationMs, completedAt,
            ...(kind === 'task' ? { taskId: evidence.taskId } : {}),
          };
          if (!validCapsule(capsule, workstreamId, 2)) throw new Error('Invalid Run Capsule.');
          data.version = 2;
          data.capsules = [...data.capsules, capsule].slice(-limit);
          await write(data);
        }).catch(() => { writeFailed = true; });
      },
    };
  }

  return { forWorkspace, flush: () => pending };
}

module.exports = { createFlightpathStore };
