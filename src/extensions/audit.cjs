const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { writeAtomic } = require('../atomic-file.cjs');
const { readCheckedFile } = require('./inspect-package.cjs');
const { packageId, versionPattern } = require('./manifest.cjs');
const { digestPattern, exactKeys } = require('./capabilities.cjs');

const operations = new Set(['activate', 'revoke', 'commands.register', 'commands.unregister', 'commands.invoke',
  'diagnostics.publish', 'diagnostics.clear', 'editor.readSelection', 'workspace.readFile', 'editor.proposeEdit',
  'editor.applyEdit', 'protocol']);
const results = new Set(['allowed', 'denied', 'failed', 'revoked']);
const codes = new Set(['OK', 'PERMISSION_DENIED', 'STALE_SESSION', 'STALE_REVISION', 'INVALID_REQUEST',
  'QUOTA', 'UNAVAILABLE', 'HOST_FAILURE', 'AUDIT_UNAVAILABLE']);
const eventKeys = ['eventId', 'time', 'extensionId', 'version', 'digest', 'workspace', 'operation', 'result', 'durationMs', 'code'];
const temporaryPrefix = '.cevra-audit-';
const temporaryPattern = /^\.cevra-audit-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/;

function validEvent(event) {
  return exactKeys(event, eventKeys) && typeof event.eventId === 'string' && /^[a-f0-9-]{36}$/.test(event.eventId) &&
    typeof event.time === 'string' && event.time.length === 24 && Number.isFinite(Date.parse(event.time)) &&
    typeof event.extensionId === 'string' && event.extensionId.length <= 100 && packageId.test(event.extensionId) &&
    typeof event.version === 'string' && versionPattern.test(event.version) && typeof event.digest === 'string' && /^[a-f0-9]{12}$/.test(event.digest) &&
    typeof event.workspace === 'string' && digestPattern.test(event.workspace) && operations.has(event.operation) && results.has(event.result) && codes.has(event.code) &&
    Number.isInteger(event.durationMs) && event.durationMs >= 0 && event.durationMs <= 60_000;
}

function createExtensionAudit(userData) {
  const folder = path.join(userData, 'extensions');
  const file = path.join(folder, 'audit.json');
  let queue = Promise.resolve();
  let recovered = false;

  async function checkedFolder() {
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(folder, { bigint: true });
    if (!stat.isDirectory() || path.relative(folder, await fs.realpath(folder)) !== '') throw new Error('Invalid audit directory.');
    return stat;
  }

  async function read() {
    let bytes;
    try { bytes = await readCheckedFile(file, 256 * 1024); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const data = JSON.parse(bytes);
    if (!exactKeys(data, ['version', 'events']) || data.version !== 1 || !Array.isArray(data.events) ||
        data.events.length > 256 || !data.events.every(validEvent)) throw new Error('Invalid audit record.');
    return data.events;
  }

  function record(identity, operation, result, code, durationMs = 0) {
    const event = {
      eventId: randomUUID(), time: new Date().toISOString(), extensionId: identity.id, version: identity.version,
      digest: identity.digest.slice(0, 12), workspace: identity.workspace, operation, result, code,
      durationMs: Math.min(60_000, Math.max(0, Math.round(durationMs))),
    };
    const task = queue.then(async () => {
      if (!validEvent(event)) throw new Error('Invalid audit event.');
      const before = await checkedFolder();
      if (!recovered) {
        for await (const entry of await fs.opendir(folder)) {
          if (entry.isFile() && temporaryPattern.test(entry.name)) await fs.unlink(path.join(folder, entry.name));
        }
        recovered = true;
      }
      const events = (await read()).slice(-255).concat(event);
      await writeAtomic(file, JSON.stringify({ version: 1, events }) + '\n', { temporaryPrefix, beforeCommit: async () => {
        const current = await checkedFolder();
        if (current.dev !== before.dev || current.ino !== before.ino || current.birthtimeNs !== before.birthtimeNs) {
          throw new Error('The audit directory changed.');
        }
      } });
    });
    queue = task.catch(() => {});
    return task;
  }

  return { record, flush: () => queue };
}

module.exports = { createExtensionAudit };
