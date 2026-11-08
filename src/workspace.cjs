const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const maxFileBytes = 2 * 1024 * 1024;
const hiddenDirectories = new Set(['.git', 'node_modules']);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function fingerprint(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createWorkspace(folder) {
  const root = await fs.realpath(folder);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Choose a project folder.');
  return { id: randomUUID(), root, name: path.basename(root) || root };
}

async function resolveEntry(workspace, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes(':')) {
    throw new Error('Invalid workspace path.');
  }
  const entry = path.resolve(workspace.root, relative);
  if (!inside(workspace.root, entry)) throw new Error('Path is outside the workspace.');
  const real = await fs.realpath(entry);
  if (!inside(workspace.root, real)) throw new Error('Path points outside the workspace.');
  return real;
}

async function listFolder(workspace, relative = '') {
  const folder = await resolveEntry(workspace, relative);
  const entries = await fs.readdir(folder, { withFileTypes: true });
  return entries
    .filter(entry => (entry.isDirectory() && !hiddenDirectories.has(entry.name)) || entry.isFile())
    .map(entry => ({
      name: entry.name,
      path: path.join(relative, entry.name),
      directory: entry.isDirectory(),
    }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function readBytes(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Choose a regular file.');
    if (stat.size > maxFileBytes) throw new Error('The editor supports files up to 2 MB.');
    const buffer = Buffer.allocUnsafe(maxFileBytes + 1);
    let length = 0;
    while (length <= maxFileBytes) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) return { bytes: buffer.subarray(0, length), mode: stat.mode };
      length += bytesRead;
    }
    throw new Error('The editor supports files up to 2 MB.');
  } finally {
    await handle.close();
  }
}

async function readSource(workspace, relative) {
  const file = await resolveEntry(workspace, relative);
  const { bytes } = await readBytes(file);
  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new Error('The editor supports UTF-8 text files.');
  }
  if (text.includes('\0')) throw new Error('The editor supports UTF-8 text files.');
  return { text, revision: fingerprint(bytes) };
}

async function verifyRevision(file, revision) {
  const current = await readBytes(file);
  if (fingerprint(current.bytes) !== revision) {
    throw new Error('This file changed on disk. Copy any unsaved edits, then reopen the file.');
  }
  return current.mode;
}

async function saveSource(workspace, relative, text, revision) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxFileBytes) {
    throw new Error('The editor supports files up to 2 MB.');
  }
  const file = await resolveEntry(workspace, relative);
  const mode = await verifyRevision(file, revision);
  const temporary = path.join(path.dirname(file), `.cevra-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', mode);
  try {
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
    await verifyRevision(file, revision);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return fingerprint(text);
}

module.exports = { createWorkspace, inside, listFolder, readSource, resolveEntry, saveSource, verifyRevision };
