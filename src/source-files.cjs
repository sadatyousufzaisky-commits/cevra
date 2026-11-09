const fs = require('node:fs');
const path = require('node:path');
const { checkedEntrySync, inside, isSourceDirectory } = require('./workspace.cjs');
const { sourceLanguage } = require('./source-language.cjs');

const maxFiles = 256;
const maxDirectories = 512;
const maxEntries = 12_000;
const configNames = ['tsconfig.json', 'jsconfig.json'];

function sourceFileKey(file) {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function collectSourceFiles(workspace, { scope = workspace.root, target, overlays, skipNestedProjects = false }) {
  const files = new Map();
  if (target) files.set(sourceFileKey(target), target);
  const scopeKey = sourceFileKey(scope);
  const boundaries = new Map();
  let separateProjects = 0;
  let scannedEntries = 0;
  let scannedDirectories = 0;
  let skipped = 0;
  let limited = false;

  function startsProject(folder) {
    const id = sourceFileKey(folder);
    if (!skipNestedProjects || id === scopeKey) return false;
    if (!boundaries.has(id)) {
      const relative = path.relative(workspace.root, folder);
      const configured = configNames.some(name => {
        try {
          return checkedEntrySync(workspace, path.join(relative, name)).stat.isFile();
        } catch {
          return false;
        }
      });
      boundaries.set(id, configured);
      if (configured) separateProjects++;
    }
    return boundaries.get(id);
  }

  for (const { file } of overlays) {
    if (!inside(scope, file)) continue;
    let folder = path.dirname(file);
    while (sourceFileKey(folder) !== scopeKey && isSourceDirectory(path.basename(folder)) && !startsProject(folder)) {
      folder = path.dirname(folder);
    }
    if (sourceFileKey(folder) === scopeKey) files.set(sourceFileKey(file), file);
  }

  const pending = [scope];
  while (pending.length && !limited) {
    if (++scannedDirectories > maxDirectories) {
      limited = true;
      break;
    }
    const folder = pending.pop();
    if (startsProject(folder)) continue;
    let directory;
    try {
      const { file, stat } = checkedEntrySync(workspace, path.relative(workspace.root, folder));
      if (!stat.isDirectory()) {
        skipped++;
        continue;
      }
      directory = fs.opendirSync(file);
      for (let entry; !limited && (entry = directory.readSync());) {
        if (++scannedEntries > maxEntries) {
          limited = true;
          break;
        }
        const absolute = path.join(folder, entry.name);
        if (entry.isDirectory() && isSourceDirectory(entry.name)) {
          pending.push(absolute);
        } else if (entry.isFile() && sourceLanguage(entry.name) && !files.has(sourceFileKey(absolute))) {
          if (files.size === maxFiles) limited = true;
          else files.set(sourceFileKey(absolute), absolute);
        }
      }
    } catch {
      skipped++;
    } finally {
      directory?.closeSync();
    }
  }
  return { files: [...files.values()], separateProjects, skipped, limited };
}

module.exports = { collectSourceFiles, sourceFileKey };
