const path = require('node:path');
const { setImmediate: yieldSearch } = require('node:timers/promises');
const { listFolder, maxFileBytes, readSource, workspacePath } = require('./workspace.cjs');

const resultLimit = 400;
const batchSize = 12;
const ignoredFolders = new Set(['.git', '.hg', '.svn', 'node_modules', '.cache', '.venv', '.pnpm-store']);
const caseInsensitivePaths = process.platform === 'win32';

function fileKey(file) {
  const normalized = path.normalize(file);
  return caseInsensitivePaths ? normalized.toLowerCase() : normalized;
}

function findMatches(source, expression, limit) {
  const matches = [];
  let line = 1;
  let start = 0;
  let next = source.indexOf('\n');
  for (const hit of source.matchAll(expression)) {
    while (next !== -1 && next < hit.index) {
      line++;
      start = next + 1;
      next = source.indexOf('\n', start);
    }
    const from = Math.max(start, hit.index - 34);
    const lineEnd = next === -1 ? source.length : next;
    const to = Math.min(lineEnd, from + 120);
    matches.push({
      line,
      column: hit.index - start + 1,
      length: hit[0].length,
      preview: (from > start ? '…' : '') + source.slice(from, to) + (to < lineEnd ? '…' : ''),
    });
    if (matches.length >= limit) break;
  }
  return matches;
}

async function searchProject(workspace, query, caseSensitive, drafts, signal) {
  if (typeof query !== 'string' || query.length < 1 || query.length > 256 || /[\r\n]/.test(query)) {
    throw new Error('Enter a search term of up to 256 characters.');
  }
  if (!Array.isArray(drafts)) throw new Error('Invalid search documents.');
  const expression = new RegExp(RegExp.escape(query), caseSensitive === true ? 'gu' : 'giu');
  const result = { files: [], count: 0, skipped: 0, limited: false };
  const open = new Set();

  function append(file, text) {
    const matches = findMatches(text, expression, resultLimit - result.count);
    if (matches.length) {
      result.files.push({ ...file, matches });
      result.count += matches.length;
      result.limited = result.count === resultLimit;
    }
  }

  for (const draft of drafts) {
    signal.throwIfAborted();
    const { path: relative, documentId, version, text } = draft;
    const file = workspacePath(workspace, relative);
    if (file === workspace.root || typeof text !== 'string' ||
        !Number.isSafeInteger(documentId) || !Number.isSafeInteger(version)) {
      throw new Error('Invalid search document.');
    }
    const key = fileKey(relative);
    open.add(key);
    if (Buffer.byteLength(text) > maxFileBytes) result.skipped++;
    else append({ path: relative, documentId, version }, text);
    if (result.limited) return result;
    await yieldSearch();
  }

  const folders = [''];
  while (folders.length) {
    signal.throwIfAborted();
    const folder = folders.pop();
    let entries;
    try {
      entries = await listFolder(workspace, folder);
    } catch (error) {
      if (!folder) throw error;
      result.skipped++;
      continue;
    }
    const files = [];
    for (const entry of entries) {
      if (entry.directory) {
        if (!ignoredFolders.has(entry.name.toLowerCase())) folders.push(entry.path);
      } else if (!open.has(fileKey(entry.path))) {
        files.push(entry.path);
      }
    }
    for (let index = 0; index < files.length; index += batchSize) {
      signal.throwIfAborted();
      const batch = files.slice(index, index + batchSize);
      const sources = await Promise.all(batch.map(relative => readSource(workspace, relative).catch(() => null)));
      for (const [offset, source] of sources.entries()) {
        signal.throwIfAborted();
        if (source) append({ path: batch[offset], revision: source.revision },
          source.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'));
        else result.skipped++;
        if (result.limited) return result;
        await yieldSearch();
      }
    }
  }
  signal.throwIfAborted();
  return result;
}

module.exports = { searchProject };
