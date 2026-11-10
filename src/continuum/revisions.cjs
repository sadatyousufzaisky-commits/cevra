const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isSourceDirectory, readInputRevision, resolveEntry, workspacePath } = require('../workspace.cjs');
const { sourceFileKey } = require('../source-files.cjs');

const limits = { files: 256, folders: 128, entries: 4096, bytes: 16 * 1024 * 1024 };

async function captureInputs(workspace, outputs = []) {
  const files = new Map();
  const keys = new Set();
  const excluded = new Set(outputs.map(sourceFileKey));
  const folders = [''];
  let complete = true;
  let entries = 0;
  let bytes = 0;
  let visited = 0;
  let attempted = 0;

  scan: while (folders.length) {
    if (++visited > limits.folders) {
      complete = false;
      break;
    }
    const relative = folders.pop();
    try {
      const folder = await resolveEntry(workspace, relative);
      for await (const entry of await fs.opendir(folder)) {
        if (++entries > limits.entries) {
          complete = false;
          break scan;
        }
        if (!isSourceDirectory(entry.name) || /^\.cevra-[a-f0-9-]+\.tmp$/i.test(entry.name)) continue;
        const file = path.join(relative, entry.name);
        if (entry.isDirectory()) {
          if (!excluded.has(sourceFileKey(file))) folders.push(file);
        }
        else if (entry.isFile()) {
          if (++attempted > limits.files) {
            complete = false;
            break scan;
          }
          const key = sourceFileKey(file);
          if (keys.has(key)) {
            complete = false;
            files.delete(key);
            continue;
          }
          keys.add(key);
          try {
            const input = await readInputRevision(workspace, file);
            bytes += input.bytes;
            if (bytes > limits.bytes) {
              complete = false;
              break scan;
            }
            files.set(key, input);
          } catch {
            complete = false;
          }
        } else {
          complete = false;
        }
      }
    } catch {
      complete = false;
    }
  }
  if (!complete) return { files };
  const records = [...files.keys()].sort().map(key => {
    const { revision, stamp } = files.get(key);
    return [key, revision, stamp];
  });
  const revision = createHash('sha256').update(JSON.stringify({
    runtime: process.versions.node,
    ...(excluded.size ? { outputs: [...excluded].sort() } : {}),
    files: records.map(([key, revision]) => [key, revision]),
  })).digest('hex');
  const stamp = createHash('sha256').update(JSON.stringify(records)).digest('hex');
  return { files, revision, stamp };
}

function inputFreshness(before, after) {
  if (!before.revision || !after.revision) return 'unavailable';
  return before.revision === after.revision && before.stamp === after.stamp ? 'observed' : 'historical';
}

function sourceAnchor(workspace, location, before, after) {
  if (!location || !Number.isSafeInteger(location.line) || location.line < 1 ||
      !Number.isSafeInteger(location.column) || location.column < 1) return null;
  try {
    const relative = path.relative(workspace.root, workspacePath(workspace, location.path));
    const key = sourceFileKey(relative);
    const first = before.files.get(key);
    const last = after.files.get(key);
    if (first && last?.revision === first.revision && last.stamp === first.stamp) {
      return { path: relative, line: location.line, column: location.column, revision: first.revision };
    }
  } catch {}
  return null;
}

function createRunEvidence(workspace) {
  let latest;
  return {
    clear() { latest = undefined; },
    remember(evidence, before, outputs) { latest = { evidence, before, outputs }; },
    async recheck(id) {
      const observed = latest;
      if (!observed || observed.evidence.id !== id) return null;
      if (observed.evidence.freshness === 'observed') {
        observed.checking ??= captureInputs(workspace, observed.outputs).then(current => {
          observed.evidence = { ...observed.evidence, freshness: inputFreshness(observed.before, current) };
        }).finally(() => { observed.checking = undefined; });
        await observed.checking;
      }
      return latest === observed ? observed.evidence : null;
    },
  };
}

module.exports = { captureInputs, createRunEvidence, inputFreshness, sourceAnchor };
