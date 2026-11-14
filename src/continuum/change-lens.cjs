const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { checkedEntrySync, resolveEntry, workspacePath } = require('../workspace.cjs');
const { sourceFileKey } = require('../source-files.cjs');
const { findGit, gitCommand } = require('./git-command.cjs');
const { revisionDigest } = require('./revisions.cjs');

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const changed = 'The Git snapshot changed. Refresh Change Lens and review it again.';
const diffLimit = 512 * 1024;
const fileLimit = 512;
const indexLimit = 16 * 1024 * 1024;
const conflict = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_START'];
const hash = value => createHash('sha256').update(value).digest('hex');
const fields = bytes => bytes.toString('utf8').split('\0').filter(Boolean);

function statusRows(bytes) {
  return fields(bytes).map(record => {
    const code = record.slice(0, 2);
    return { path: record.slice(3), index: code[0], working: code[1], conflict: conflict.has(code) };
  });
}

function indexEntries(bytes) {
  return fields(bytes).map(record => {
    const match = /^(\d{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match || !oid.test(match[2])) throw new Error('The Git index format is unavailable.');
    return { mode: match[1], id: match[2], stage: match[3], path: match[4] };
  });
}

function treeEntries(bytes) {
  return fields(bytes).map(record => {
    const match = /^(\d{6}) \w+ ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match || !oid.test(match[2])) throw new Error('The Git tree format is unavailable.');
    return { mode: match[1], id: match[2], stage: '0', path: match[3] };
  });
}

const treeSignature = entries => hash(JSON.stringify(entries.map(item => [item.path, item.mode, item.id, item.stage]).sort()));
const isStaged = row => row.index !== ' ' && row.index !== '?' && !row.conflict;

async function indexRevision(git, entries) {
  if (entries.length > 256 || entries.some(item => item.stage !== '0' || !['100644', '100755'].includes(item.mode))) return null;
  const limit = 16 * 1024 * 1024;
  const { bytes } = await git(['cat-file', '--batch'], { input: entries.map(item => item.id + '\n').join(''), limit: limit + 32_768 });
  const records = new Map();
  let cursor = 0;
  let total = 0;
  for (const entry of entries) {
    const end = bytes.indexOf(10, cursor);
    if (end < 0 || end - cursor > 90) return null;
    const [id, type, size] = bytes.toString('ascii', cursor, end).split(' ');
    const length = Number(size);
    if (id !== entry.id || type !== 'blob' || !Number.isSafeInteger(length) || length < 0 || length > 2 * 1024 * 1024 ||
        (total += length) > limit || bytes[end + 1 + length] !== 10) return null;
    const key = sourceFileKey(entry.path);
    if (records.has(key)) return null;
    records.set(key, hash(bytes.subarray(end + 1, end + 1 + length)));
    cursor = end + 2 + length;
  }
  if (cursor !== bytes.length) return null;
  return revisionDigest([...records.keys()].sort().map(key => [key, records.get(key)]));
}

async function verification(git, entries, evidence, history) {
  const live = evidence();
  const retained = live ? null : (await history.view()).capsules.findLast(item => item.kind === 'test' && !item.retry);
  const test = live ?? retained;
  if (!test) return { state: 'none' };
  const stagedRevision = await indexRevision(git, entries).catch(() => null);
  const result = { testRevision: test.revision, stagedRevision };
  if (!stagedRevision || !test.revision) return { ...result, state: 'unavailable' };
  if (test.revision !== stagedRevision || test.freshness !== 'observed' || !live) return { ...result, state: 'historical' };
  return { ...result, state: test.outcome === 'passed' && test.hasPasses ? 'matches' : 'unverified' };
}

function createChangeLens(workspace, history, evidence) {
  let executable;

  async function repository() {
    const root = await resolveEntry(workspace, '');
    executable ??= await findGit(root);
    const base = gitCommand(executable, root);
    const top = await base(['rev-parse', '--show-toplevel'], { codes: [0, 128] });
    if (top.code !== 0) {
      if (/not a git repository/i.test(top.error)) return { message: 'Open a Git repository folder to review changes.' };
      throw new Error(top.error.trim());
    }
    const actual = await fs.realpath(top.bytes.toString('utf8').trim());
    if (path.relative(root, actual) !== '') return { message: 'Open the repository root to review its full staged snapshot.' };
    const gitDir = path.join(root, '.git');
    const metadata = await fs.lstat(gitDir, { bigint: true }).catch(() => null);
    const writable = Boolean(metadata?.isDirectory() && path.relative(gitDir, await fs.realpath(gitDir)) === '');
    const configured = await base(['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], { codes: [0, 1] });
    const drivers = [...new Set(fields(configured.bytes).map(key => key.slice(7, key.lastIndexOf('.'))))];
    if (drivers.length > 32 || drivers.some(driver => !driver || driver.length > 96 || driver.includes('='))) {
      throw new Error('This repository has unsupported external filter configuration.');
    }
    const overrides = drivers.flatMap(driver => ['clean=', 'smudge=', 'process=', 'required=false'].flatMap(setting => ['-c', 'filter.' + driver + '.' + setting]));
    const identity = writable ? `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}` : '';
    return { root, gitDir, writable, identity, drivers, git: gitCommand(executable, root, overrides) };
  }

  async function snapshot(repo) {
    const { git } = repo;
    if (repo.writable) {
      const stat = await fs.lstat(repo.gitDir, { bigint: true });
      if (!stat.isDirectory() || `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` !== repo.identity) throw new Error(changed);
    }
    const [ref, head, raw, staged] = await Promise.all([
      git(['symbolic-ref', '-q', 'HEAD'], { codes: [0, 1] }), git(['rev-parse', '--verify', 'HEAD'], { codes: [0, 128] }),
      git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']), git(['ls-files', '--stage', '-z']),
    ]);
    const branchRef = ref.bytes.toString('utf8').trim();
    const tip = head.bytes.toString('ascii').trim();
    const rows = statusRows(raw.bytes);
    const busy = repo.writable && (await Promise.all(operations.map(name => fs.lstat(path.join(repo.gitDir, name))
      .then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })))).some(Boolean);
    return { branchRef, tip, rows, busy, entries: indexEntries(staged.bytes),
      id: hash(JSON.stringify([repo.identity, branchRef, tip, hash(raw.bytes), hash(staged.bytes), busy])) };
  }

  async function current(expected) {
    const repo = await repository();
    if (!repo.git) throw new Error(repo.message);
    const state = await snapshot(repo);
    if (expected !== undefined && expected !== state.id) throw new Error(changed);
    return { repo, state };
  }

  function writable(repo, state) {
    if (!repo.writable) throw new Error('Open a standard repository checkout to make Git changes in VOKRI Code.');
    if (state.busy || state.rows.some(row => row.conflict)) throw new Error('Finish the active Git operation or resolve conflicts before making changes in VOKRI Code.');
    if (state.rows.length > fileLimit) throw new Error('This repository has too many changed paths for a complete review.');
  }

  async function safeFile(file) {
    if (typeof file !== 'string' || !file || file.length > 2048 || file.endsWith('/')) throw new Error('Select a regular repository file.');
    const absolute = workspacePath(workspace, file);
    try {
      if (!checkedEntrySync(workspace, file).stat.isFile()) throw new Error('Select a regular repository file.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A deleted file is valid, but its nearest existing parent must still be within this checkout.
      let parent = path.dirname(absolute);
      while (parent !== workspace.root) {
        try { await resolveEntry(workspace, path.relative(workspace.root, parent)); break; }
        catch (problem) { if (problem.code !== 'ENOENT') throw problem; parent = path.dirname(parent); }
      }
    }
    return absolute;
  }

  async function patch(repo, state, file, side) {
    const row = state.rows.find(item => item.path === file);
    if (!row || !['staged', 'working'].includes(side) || (side === 'staged' ? !isStaged(row) : row.working === ' ')) {
      throw new Error('Select a changed file and the side to review.');
    }
    const absolute = await safeFile(file);
    const base = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];
    const untracked = row.index === '?';
    const result = untracked ? await repo.git([...base, '--no-index', '--', '/dev/null', absolute], { codes: [0, 1], limit: diffLimit, truncate: true }) :
      await repo.git([...base, ...(side === 'staged' ? ['--cached'] : []), '--', file], { limit: diffLimit, truncate: true });
    let object = null;
    if (side === 'working' && row.working !== 'D' && !result.clipped) {
      object = (await repo.git(['hash-object', '--path=' + file, '--', absolute])).bytes.toString('ascii').trim();
      if (!oid.test(object)) throw new Error('Could not identify the working file bytes.');
    }
    return { text: result.bytes.toString('utf8'), clipped: result.clipped, object,
      id: hash(JSON.stringify([hash(result.bytes), object])) };
  }

  async function review(expected) {
    const { repo, state } = await current(expected);
    writable(repo, state);
    if (!state.branchRef.startsWith('refs/heads/')) throw new Error('Switch to a local branch before committing.');
    const files = state.rows.filter(isStaged).map(row => row.path);
    if (!files.length) throw new Error('Stage files before reviewing a commit.');
    const diff = await repo.git(['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--'],
      { limit: diffLimit, truncate: true });
    if (diff.clipped) throw new Error('The staged diff exceeds the review limit. Review a smaller commit.');
    return { id: state.id, files, branch: state.branchRef.slice(11), text: diff.bytes.toString('utf8'),
      verification: await verification(repo.git, state.entries, evidence, history) };
  }

  async function rejectFilters(repo, files, source) {
    if (!repo.drivers.length || !files.length) return;
    const { bytes } = await repo.git(['check-attr', '-z', ...(source ? ['--source=' + source] : []), '--stdin', 'filter'],
      { input: files.map(file => file + '\0').join('') });
    const attrs = fields(bytes);
    for (let index = 2; index < attrs.length; index += 3) {
      if (repo.drivers.includes(attrs[index])) throw new Error('This action would use an external Git filter. Review and run it in your terminal.');
    }
  }

  async function editIndex(repo, state, edit) {
    const index = path.join(repo.gitDir, 'index');
    const lockPath = index + '.lock';
    const scratch = path.join(repo.gitDir, 'cevra-index-' + randomUUID());
    const lock = await fs.open(lockPath, 'wx', 0o600).catch(error => {
      if (error.code === 'EEXIST') throw new Error('Another Git operation owns the index lock. Try again when it finishes.');
      throw error;
    });
    let installed = false;
    try {
      if ((await snapshot(repo)).id !== state.id) throw new Error(changed);
      const existing = await fs.lstat(index).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (existing) {
        if (!existing.isFile() || existing.nlink !== 1 || existing.size > indexLimit) throw new Error('The Git index cannot be edited safely.');
        await fs.copyFile(index, scratch);
      }
      await edit(scratch);
      const prepared = await fs.stat(scratch);
      if (prepared.size > indexLimit) throw new Error('The Git index exceeded the review limit.');
      await lock.writeFile(await fs.readFile(scratch));
      await lock.sync();
      await lock.close();
      await fs.rename(lockPath, index);
      installed = true;
    } finally {
      await lock.close().catch(() => {});
      if (!installed) await fs.rm(lockPath, { force: true }).catch(() => {});
      await fs.rm(scratch, { force: true }).catch(() => {});
    }
  }

  return {
    async status() {
      const repo = await repository();
      if (!repo.git) return { message: repo.message };
      const state = await snapshot(repo);
      const [refs, log, proof] = await Promise.all([
        repo.git(['for-each-ref', '--count=128', '--format=%(refname)', 'refs/heads']),
        state.tip ? repo.git(['log', '-12', '-z', '--format=%H%x00%h%x00%s', state.tip, '--']) : null,
        verification(repo.git, state.entries, evidence, history),
      ]);
      const historyFields = log ? log.bytes.toString('utf8').split('\0').slice(0, -1) : [];
      const historyRows = [];
      for (let i = 0; i + 2 < historyFields.length; i += 3) {
        historyRows.push({ id: historyFields[i], short: historyFields[i + 1], subject: historyFields[i + 2] });
      }
      return { id: state.id, root: repo.root, branch: state.branchRef.slice(11) || 'Detached HEAD', tip: state.tip,
        rows: state.rows.slice(0, fileLimit), clipped: state.rows.length > fileLimit,
        branches: refs.bytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(name => name.slice(11)), history: historyRows, verification: proof,
        writable: repo.writable && !state.busy && !state.rows.some(row => row.conflict) && state.rows.length <= fileLimit };
    },
    async diff(expected, file, side) {
      const { repo, state } = await current(expected);
      return patch(repo, state, file, side);
    },
    review,
    async stage(expected, file, side, diffId) {
      const { repo, state } = await current(expected);
      writable(repo, state);
      const checkPatch = async () => {
        const preview = await patch(repo, state, file, side);
        if (preview.clipped || preview.id !== diffId) throw new Error(changed);
        return preview;
      };
      await editIndex(repo, state, async indexFile => {
        const preview = await checkPatch();
        if (side === 'working') {
          await rejectFilters(repo, [file]);
          await repo.git(['add', '--', file], { indexFile });
          const entries = indexEntries((await repo.git(['ls-files', '--stage', '-z', '--', file], { indexFile })).bytes);
          if (preview.object ? entries.length !== 1 || entries[0].id !== preview.object || !['100644', '100755'].includes(entries[0].mode) : entries.length) {
            throw new Error(changed);
          }
          await checkPatch();
        } else if (state.tip) await repo.git(['restore', '--staged', '--', file], { indexFile });
        else await repo.git(['rm', '--cached', '--force', '--', file], { indexFile });
      });
    },
    async commit(expected, message) {
      if (typeof message !== 'string' || !message.trim() || message.includes('\0') || Buffer.byteLength(message) > 4096) {
        throw new Error('Enter a commit message of up to 4096 bytes.');
      }
      const { repo, state } = await current(expected);
      writable(repo, state);
      if (!state.branchRef.startsWith('refs/heads/') || !state.rows.some(isStaged)) throw new Error('Review staged changes on a local branch first.');
      const tree = (await repo.git(['write-tree'])).bytes.toString('ascii').trim();
      if (!oid.test(tree)) throw new Error('Could not identify the reviewed Git tree.');
      const written = treeEntries((await repo.git(['ls-tree', '-r', '-z', tree])).bytes);
      if (treeSignature(written) !== treeSignature(state.entries)) throw new Error(changed);
      const args = ['-c', 'i18n.commitEncoding=UTF-8', 'commit-tree', tree, '--no-gpg-sign', ...(state.tip ? ['-p', state.tip] : []), '-F', '-'];
      const commit = (await repo.git(args, { input: message.trim() + '\n' })).bytes.toString('ascii').trim();
      if (!oid.test(commit)) throw new Error('Could not identify the created Git commit.');
      const latest = await snapshot(repo);
      if (latest.branchRef !== state.branchRef || latest.tip !== state.tip || latest.busy) throw new Error(changed);
      await repo.git(['update-ref', '--no-deref', '-m', 'commit: ' + message.trim().split(/\r?\n/, 1)[0].slice(0, 120),
        state.branchRef, commit, state.tip || '0'.repeat(commit.length)]);
      return commit;
    },
    async branch(expected, action, name) {
      if (typeof name !== 'string' || !name || name.length > 120 || name.startsWith('-') || /[\0\r\n]/.test(name)) throw new Error('Enter a valid local branch name.');
      const { repo, state } = await current(expected);
      writable(repo, state);
      if (action === 'create') {
        const checked = await repo.git(['check-ref-format', '--branch', name]);
        if (checked.bytes.toString('utf8').trim() !== name) throw new Error('Enter a literal local branch name.');
        await repo.git(['branch', '--', name]);
      } else if (action === 'switch') {
        if (state.rows.length) throw new Error('Commit or move working changes before switching branches.');
        const ref = 'refs/heads/' + name;
        await repo.git(['show-ref', '--verify', '--', ref]);
        if (repo.drivers.length) {
          const target = treeEntries((await repo.git(['ls-tree', '-r', '-z', ref])).bytes);
          await rejectFilters(repo, state.entries.map(item => item.path));
          await rejectFilters(repo, target.map(item => item.path), ref);
        }
        if ((await snapshot(repo)).id !== state.id) throw new Error(changed);
        await repo.git(['switch', '--no-guess', '--no-recurse-submodules', '--', name]);
      } else throw new Error('Unknown branch action.');
    },
  };
}

module.exports = { createChangeLens };
