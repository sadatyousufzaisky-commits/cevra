const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { writeAtomic } = require('./atomic-file.cjs');

const maxFileBytes = 2 * 1024 * 1024;
const hiddenDirectories = new Set(['.git', 'node_modules']);
const skippedSourceDirectories = new Set([...hiddenDirectories, '.hg', '.svn', '.cache', '.venv', '.pnpm-store']);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const pendingWrites = new Map();
const windows = process.platform === 'win32';
const reservedName = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i;

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function isSourceDirectory(name) {
  return !skippedSourceDirectories.has(name.toLowerCase());
}

function fingerprint(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createWorkspace(folder) {
  const root = await fs.realpath(folder);
  const identity = await fs.stat(root, { bigint: true });
  if (!identity.isDirectory()) throw new Error('Choose a project folder.');
  return { id: randomUUID(), root, identity, name: path.basename(root) || root };
}

function workspacePath(workspace, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || /[:\0]/.test(relative)) {
    throw new Error('Invalid workspace path.');
  }
  const parts = relative.split(windows ? /[\\/]/ : '/');
  if (parts.some(part => part === '..')) throw new Error('Path is outside the workspace.');
  if (parts.some(part => hiddenDirectories.has(part.toLowerCase()) ||
    (windows && part !== '.' && (/[. ]$/.test(part) || reservedName.test(part))))) {
    throw new Error('Invalid workspace path.');
  }
  const entry = path.resolve(workspace.root, relative);
  if (!inside(workspace.root, entry)) throw new Error('Path is outside the workspace.');
  return entry;
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function checkRoot(workspace, root) {
  if (!root.isDirectory() || !sameFile(root, workspace.identity)) {
    throw new Error('The workspace folder changed. Open it again.');
  }
}

function checkEntryPath(entry, real) {
  if (path.relative(entry, real) !== '') throw new Error('Workspace links cannot be opened.');
}

function checkEntryType(stat) {
  if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1n)) {
    throw new Error('Workspace links cannot be opened.');
  }
}

async function checkedEntry(workspace, relative) {
  const entry = workspacePath(workspace, relative);
  checkRoot(workspace, await fs.lstat(workspace.root, { bigint: true }));
  const real = await fs.realpath(entry);
  checkEntryPath(entry, real);
  const stat = await fs.lstat(real, { bigint: true });
  checkEntryType(stat);
  return { file: real, stat };
}

// TypeScript's host reads synchronously in the language worker, using the same workspace checks.
function checkedEntrySync(workspace, relative) {
  const entry = workspacePath(workspace, relative);
  checkRoot(workspace, syncFs.lstatSync(workspace.root, { bigint: true }));
  const real = syncFs.realpathSync.native(entry);
  checkEntryPath(entry, real);
  const stat = syncFs.lstatSync(real, { bigint: true });
  checkEntryType(stat);
  return { file: real, stat };
}

async function resolveEntry(workspace, relative) {
  return (await checkedEntry(workspace, relative)).file;
}

async function listFolder(workspace, relative = '') {
  const folder = await resolveEntry(workspace, relative);
  const entries = await fs.readdir(folder, { withFileTypes: true });
  return entries
    .filter(entry => !hiddenDirectories.has(entry.name.toLowerCase()) &&
      !/^\.cevra-[a-f0-9-]+\.tmp$/i.test(entry.name) && (entry.isDirectory() || entry.isFile()))
    .map(entry => ({
      name: entry.name,
      path: path.join(relative, entry.name),
      directory: entry.isDirectory(),
    }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function checkSourceSize(stat) {
  if (!stat.isFile()) throw new Error('Choose a regular file.');
  if (stat.size > BigInt(maxFileBytes)) throw new Error('The editor supports files up to 2 MB.');
}

function sourceBuffer(stat, opened) {
  if (!opened.isFile() || opened.nlink !== 1n || !sameFile(stat, opened)) {
    throw new Error('The file changed while opening it. Try again.');
  }
  checkSourceSize(opened);
  return Buffer.allocUnsafe(Number(opened.size) + 1);
}

function checkRead(opened, current, length) {
  if (BigInt(length) !== opened.size || current.size !== opened.size || current.mtimeNs !== opened.mtimeNs) {
    throw new Error('The file changed while reading it. Try again.');
  }
}

const readFlags = syncFs.constants.O_RDONLY | (syncFs.constants.O_NOFOLLOW ?? 0);

async function readBytes(workspace, relative) {
  const { file, stat } = await checkedEntry(workspace, relative);
  checkSourceSize(stat);
  const handle = await fs.open(file, readFlags);
  try {
    const opened = await handle.stat({ bigint: true });
    const buffer = sourceBuffer(stat, opened);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    checkRead(opened, await handle.stat({ bigint: true }), length);
    return { file, bytes: buffer.subarray(0, length), stat: opened };
  } finally {
    await handle.close();
  }
}

function decodeSource(bytes) {
  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new Error('The editor supports UTF-8 text files.');
  }
  if (text.includes('\0')) throw new Error('The editor supports UTF-8 text files.');
  return { text, revision: fingerprint(bytes) };
}

async function readSource(workspace, relative) {
  return decodeSource((await readBytes(workspace, relative)).bytes);
}

function readSourceSync(workspace, relative) {
  const { file, stat } = checkedEntrySync(workspace, relative);
  checkSourceSize(stat);
  const handle = syncFs.openSync(file, readFlags);
  try {
    const opened = syncFs.fstatSync(handle, { bigint: true });
    const buffer = sourceBuffer(stat, opened);
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = syncFs.readSync(handle, buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    checkRead(opened, syncFs.fstatSync(handle, { bigint: true }), length);
    return decodeSource(buffer.subarray(0, length));
  } finally {
    syncFs.closeSync(handle);
  }
}

async function verifyRevision(workspace, relative, revision) {
  const current = await readBytes(workspace, relative);
  if (fingerprint(current.bytes) !== revision) {
    throw new Error('This file changed on disk. Copy any unsaved edits, then reopen the file.');
  }
  return current;
}

function validateText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxFileBytes) {
    throw new Error('The editor supports files up to 2 MB.');
  }
  if (text.includes('\0')) throw new Error('The editor supports UTF-8 text files.');
}

async function saveSource(workspace, relative, text, revision) {
  validateText(text);
  const target = workspacePath(workspace, relative);
  const key = windows ? target.toLowerCase() : target;
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const save = previous.catch(() => {}).then(async () => {
    const current = await verifyRevision(workspace, relative, revision);
    await writeAtomic(current.file, text, {
      mode: Number(current.stat.mode) & 0o777,
      beforeCommit: async () => {
        const latest = await verifyRevision(workspace, relative, revision);
        if (!sameFile(current.stat, latest.stat)) throw new Error('The file was replaced while saving.');
      },
    });
    return fingerprint(text);
  });
  pendingWrites.set(key, save);
  try {
    return await save;
  } finally {
    if (pendingWrites.get(key) === save) pendingWrites.delete(key);
  }
}

async function saveRecoveryCopy(workspace, relative, text) {
  validateText(text);
  const target = workspacePath(workspace, relative);
  if (path.relative(workspace.root, target) === '') throw new Error('Choose a regular file.');
  const original = path.parse(target);
  const name = original.name.slice(0, 100) + ' (recovered ' + randomUUID().slice(0, 8) + ')' + original.ext;
  await checkedEntry(workspace, '');
  const file = workspacePath(workspace, name);
  const handle = await fs.open(file, 'wx', 0o600);
  let completed = false;
  try {
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    completed = true;
  } finally {
    if (!completed) await fs.unlink(file).catch(() => {});
  }
  return name;
}

module.exports = {
  checkedEntrySync, createWorkspace, inside, isSourceDirectory, listFolder, maxFileBytes, readSource, readSourceSync, resolveEntry, saveSource, saveRecoveryCopy,
  verifyRevision, workspacePath,
};
