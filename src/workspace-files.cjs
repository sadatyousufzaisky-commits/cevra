const path = require('node:path');
const { setImmediate: yieldToApp } = require('node:timers/promises');
const { isSourceDirectory, listFolder } = require('./workspace.cjs');

function matchScore(text, term) {
  const contiguous = text.indexOf(term);
  if (contiguous !== -1) return contiguous === 0 ? 0 : 5 + contiguous;
  let index = -1;
  for (const character of term) {
    index = text.indexOf(character, index + 1);
    if (index === -1) return Infinity;
  }
  return 40 + index;
}

function rank(entry, terms) {
  const name = entry.name.toLowerCase();
  const relative = entry.path.split(path.sep).join('/').toLowerCase();
  return terms.reduce((score, term) => score + Math.min(matchScore(name, term), 24 + matchScore(relative, term)), 0);
}

async function findWorkspaceFiles(workspace, input, signal) {
  if (typeof input !== 'string' || !input.trim() || input.length > 120 || /[\r\n\0]/.test(input)) {
    throw new Error('Enter a file name or path of up to 120 characters.');
  }
  const terms = input.trim().toLowerCase().replaceAll('\\', '/').split(/\s+/);
  const folders = [''];
  const matches = [];
  let examined = 0;
  let skipped = 0;
  let limited = false;
  for (let index = 0; index < folders.length; index++) {
    signal.throwIfAborted();
    let entries;
    try { entries = await listFolder(workspace, folders[index]); }
    catch (error) {
      if (index === 0) throw error;
      skipped++;
      continue;
    }
    for (const entry of entries) {
      if (++examined > 12_000) {
        limited = true;
        break;
      }
      if (entry.directory) {
        if (!isSourceDirectory(entry.name)) continue;
        if (folders.length < 600) folders.push(entry.path);
        else limited = true;
      } else {
        const score = rank(entry, terms);
        if (Number.isFinite(score)) matches.push({ ...entry, score });
      }
    }
    if (examined > 12_000) break;
    await yieldToApp();
  }
  signal.throwIfAborted();
  matches.sort((first, second) => first.score - second.score || first.path.length - second.path.length || first.path.localeCompare(second.path));
  return { files: matches.slice(0, 30).map(({ path, name }) => ({ path, name })), more: matches.length > 30, limited, skipped };
}

module.exports = { findWorkspaceFiles };
