const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { types } = require('./windows-file-types.json');
const { inside, readSource } = require('./workspace.cjs');

const extensions = new Set(Object.values(types).flat());
const maxSelection = 32;
const reserved = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i;
const unsupported = new Set(['.git', 'node_modules']);
const samePath = (left, right) => path.win32.relative(left, right) === '';
const unavailable = () => new Error('An Explorer item changed or is unavailable. Select it again in Explorer.');
const identity = stat => [stat.dev, stat.ino, stat.birthtimeNs].join(':');

function activationArguments(argv) {
  const index = argv.indexOf('--vokri-open');
  if (index < 0 || argv[index + 1] !== '--') return [];
  return argv.slice(index + 2);
}

function localPath(input, cwd) {
  if (typeof input !== 'string' || !input.length || input.length > 32767 || /[\x00-\x1f"<>|?*]/.test(input.replace(/^\\\\\?\\(?=[a-z]:\\)/i, ''))) {
    throw unavailable();
  }
  const value = input.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '').replaceAll('/', '\\');
  const drive = /^[a-z]:\\/i;
  if (value.startsWith('\\') || value.startsWith('-') || /:/.test(drive.test(value) ? value.slice(2) : value)) throw unavailable();
  const parts = (drive.test(value) ? value.slice(3) : value).split('\\').filter(Boolean);
  if (parts.some(part => (part !== '.' && /[. ]$/.test(part)) || reserved.test(part) || unsupported.has(part.toLowerCase()))) throw unavailable();
  if (!drive.test(value) && (typeof cwd !== 'string' || !drive.test(cwd))) throw unavailable();
  const resolved = path.win32.resolve(cwd ?? value, value);
  if (resolved.slice(3).split('\\').some(part => unsupported.has(part.toLowerCase()))) throw unavailable();
  return resolved;
}

async function checkItem(file) {
  if (!samePath(await fs.realpath(file), file)) throw unavailable();
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n || !extensions.has(path.extname(file).toLowerCase()))) throw unavailable();
  return { file, folder: stat.isDirectory(), identity: identity(stat) };
}

function commonFolder(files) {
  let folder = path.dirname(files[0].file);
  while (!files.every(item => inside(folder, item.file))) {
    const upper = path.dirname(folder);
    if (upper === folder) return undefined;
    folder = upper;
  }
  return folder === path.parse(folder).root ? undefined : folder;
}

async function explorerPlans(selection, workspace) {
  const valid = new Map();
  let rejected = 0;
  for (const { input, cwd } of selection) {
    try {
      const target = await checkItem(localPath(input, cwd));
      valid.set(target.file.toLowerCase(), target);
    } catch { rejected++; }
  }
  const groups = new Map();
  const remaining = [];
  for (const item of valid.values()) if (item.folder) groups.set(item.file.toLowerCase(), { root: item.file, files: [] });
  for (const item of valid.values()) {
    if (item.folder) continue;
    let group = [...groups.values()].filter(group => inside(group.root, item.file)).sort((a, b) => b.root.length - a.root.length)[0];
    if (!group && workspace && inside(workspace.root, item.file)) {
      const key = workspace.root.toLowerCase();
      if (!groups.has(key)) groups.set(key, { root: workspace.root, files: [] });
      group = groups.get(key);
    }
    if (group) group.files.push(item);
    else remaining.push(item);
  }
  const common = remaining.length > 1 ? commonFolder(remaining) : undefined;
  for (const item of remaining) {
    const root = common ?? path.dirname(item.file);
    const key = root.toLowerCase();
    if (!groups.has(key)) groups.set(key, { root, files: [] });
    groups.get(key).files.push(item);
  }
  const plans = [];
  for (const { root, files } of groups.values()) {
    try {
      const folder = await checkItem(root);
      const requestedFolder = valid.get(root.toLowerCase());
      if (!folder.folder || (requestedFolder && requestedFolder.identity !== folder.identity)) throw unavailable();
      const rootStat = await fs.stat(root, { bigint: true });
      if (identity(rootStat) !== folder.identity) throw unavailable();
      const readable = [];
      for (const item of files) {
        try {
          await readSource({ root, identity: rootStat }, path.relative(root, item.file));
          readable.push(item);
        } catch { rejected++; }
      }
      if (readable.length || requestedFolder) plans.push({ id: randomUUID(), root, identity: folder.identity, files: readable });
    } catch { rejected += files.length || 1; }
  }
  return { plans, rejected };
}

async function verifyExplorerPlan(plan, workspace) {
  if (!samePath(plan.root, workspace.root) || identity(workspace.identity) !== plan.identity ||
      (await checkItem(plan.root)).identity !== plan.identity) throw unavailable();
  const entries = [];
  for (const entry of plan.files) {
    const checked = await checkItem(entry.file);
    if (checked.folder || checked.identity !== entry.identity) throw unavailable();
    const relative = path.relative(workspace.root, entry.file);
    await readSource(workspace, relative);
    entries.push(relative);
  }
  return entries;
}

function createExplorerQueue(current, changed) {
  const raw = [];
  const plans = [];
  let timer;
  let resolving = 0;
  let rejected = 0;
  function emit(automatic) {
    if (changed({ pending: plans.length, rejected, automatic })) rejected = 0;
  }
  async function flush() {
    if (resolving || !raw.length) return;
    const batch = raw.splice(0);
    resolving = batch.length;
    try {
      const { plans: ready, rejected: invalid } = await explorerPlans(batch, current());
      rejected += invalid;
      const automatic = plans.length === 0;
      plans.push(...ready);
      emit(automatic);
    } catch {
      rejected += batch.length;
      emit(false);
    } finally {
      resolving = 0;
      if (raw.length) schedule();
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 180);
  }
  return {
    enqueue(inputs, cwd) {
      if (!Array.isArray(inputs) || !inputs.length) return;
      const waiting = plans.reduce((size, plan) => size + Math.max(1, plan.files.length), raw.length + resolving);
      const allowed = Math.max(0, maxSelection - waiting);
      rejected += Math.max(0, inputs.length - allowed);
      raw.push(...inputs.slice(0, allowed).map(input => ({ input, cwd })));
      if (raw.length) schedule();
      else emit(false);
    },
    ready() { emit(true); },
    peek: () => plans[0],
    finish(id) {
      if (plans[0]?.id !== id) return;
      plans.shift();
      emit(false);
    },
  };
}

module.exports = { activationArguments, createExplorerQueue, explorerPlans, localPath, samePath, verifyExplorerPlan };
