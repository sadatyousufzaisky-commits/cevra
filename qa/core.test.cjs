const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { temporaryFolder } = require('./temp.cjs');
const { createWorkspace, listFolder, readSource, saveSource, saveRecoveryCopy } = require('../src/workspace.cjs');
const { startNodeRun, startNodeTests } = require('../src/runner.cjs');
const { createDraftStore } = require('../src/drafts.cjs');
const { writeAtomic } = require('../src/atomic-file.cjs');
const { searchProject } = require('../src/project-search.cjs');

async function fixture(t) {
  const folder = await temporaryFolder(t, 'cevra-core-');
  const root = path.join(folder, 'project (QA) # % & café');
  await fs.mkdir(root);
  return { folder, root, workspace: await createWorkspace(root) };
}

test('workspace operations reject traversal, absolute paths, alternate streams, and hidden directories', async t => {
  const { folder, root, workspace } = await fixture(t);
  const outside = path.join(folder, 'outside.cjs');
  await fs.writeFile(outside, 'outside');
  await fs.writeFile(path.join(root, 'entry.cjs'), 'inside');
  const { revision } = await readSource(workspace, 'entry.cjs');

  const forbidden = ['../outside.cjs', outside, 'entry.cjs:alternate', '.git/config', 'node_modules/x.cjs'];
  if (process.platform === 'win32') forbidden.push('CON.cjs', 'NUL .cjs', 'entry.cjs.', 'entry.cjs ', '..\\outside.cjs');
  for (const relative of forbidden) {
    await assert.rejects(readSource(workspace, relative), /[Ww]orkspace path|outside the workspace/);
    await assert.rejects(saveSource(workspace, relative, 'modified', revision), /[Ww]orkspace path|outside the workspace/);
    await assert.rejects(listFolder(workspace, relative), /[Ww]orkspace path|outside the workspace/);
  }
  await assert.rejects(startNodeRun(workspace, '../outside.cjs', revision, () => {}), /outside the workspace/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  assert.equal(await fs.readFile(path.join(root, 'entry.cjs'), 'utf8'), 'inside');
});

test('workspace operations reject junctions, links, and replacement of the opened root', async t => {
  const { folder, root, workspace } = await fixture(t);
  const outside = path.join(folder, 'sibling');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'outside.cjs'), 'outside');
  await fs.writeFile(path.join(root, 'inside.cjs'), 'inside');
  const { revision } = await readSource(workspace, 'inside.cjs');
  await fs.symlink(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.link(path.join(outside, 'outside.cjs'), path.join(root, 'hard-link.cjs'));
  await assert.rejects(listFolder(workspace, 'outside-link'), /links cannot be opened/);
  for (const relative of [path.join('outside-link', 'outside.cjs'), 'hard-link.cjs']) {
    await assert.rejects(readSource(workspace, relative), /links cannot be opened/);
    await assert.rejects(saveSource(workspace, relative, 'modified', revision), /links cannot be opened/);
    await assert.rejects(startNodeRun(workspace, relative, revision, () => {}), /links cannot be opened/);
  }
  assert.equal(await fs.readFile(path.join(outside, 'outside.cjs'), 'utf8'), 'outside');

  await fs.rename(root, path.join(folder, 'original'));
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'inside.cjs'), 'inside');
  await assert.rejects(readSource(workspace, 'inside.cjs'), /workspace folder changed/);
  await assert.rejects(saveSource(workspace, 'inside.cjs', 'modified', revision), /workspace folder changed/);
  await assert.rejects(startNodeTests(workspace, path.join(folder, 'test-state.json'), () => {}), /workspace folder changed/);
  assert.equal(await fs.readFile(path.join(root, 'inside.cjs'), 'utf8'), 'inside');
});

test('saves atomically, serializes competing revisions, and preserves existing recovery copies', async t => {
  const { root, workspace } = await fixture(t);
  const file = path.join(root, 'draft.txt');
  await fs.writeFile(file, 'original');
  const { revision } = await readSource(workspace, 'draft.txt');
  const results = await Promise.allSettled([
    saveSource(workspace, 'draft.txt', 'first edit', revision),
    saveSource(workspace, 'draft.txt', 'second edit', revision),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /changed on disk/);
  assert.equal(await fs.readFile(file, 'utf8'), 'first edit');
  const first = await saveRecoveryCopy(workspace, 'draft.txt', 'recovered one');
  const second = await saveRecoveryCopy(workspace, 'draft.txt', 'recovered two');
  assert.notEqual(first, second);
  assert.equal(await fs.readFile(path.join(root, first), 'utf8'), 'recovered one');
  assert.equal(await fs.readFile(path.join(root, second), 'utf8'), 'recovered two');
  assert.equal(await fs.readFile(file, 'utf8'), 'first edit');
  assert.deepEqual((await fs.readdir(root)).sort(), [first, second, 'draft.txt'].sort());
});

test('an interrupted atomic write leaves the previous file intact and cleans up its temporary file', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'original.txt');
  await fs.writeFile(file, 'previous contents');
  await assert.rejects(writeAtomic(file, 'candidate contents', {
    beforeCommit() { throw new Error('simulated failed commit'); },
  }), /simulated failed commit/);
  assert.equal(await fs.readFile(file, 'utf8'), 'previous contents');
  assert.deepEqual(await fs.readdir(root), ['original.txt']);
});

test('rejects directories, invalid UTF-8, binary text, and oversized files without changing disk', async t => {
  const { root, workspace } = await fixture(t);
  await fs.mkdir(path.join(root, 'directory.cjs'));
  await fs.writeFile(path.join(root, 'encoding.txt'), Buffer.from([0xff]));
  await fs.writeFile(path.join(root, 'binary.txt'), Buffer.from([0]));
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 97));
  await fs.writeFile(path.join(root, 'normal.txt'), 'original');
  await assert.rejects(readSource(workspace, 'directory.cjs'), /regular file/);
  await assert.rejects(readSource(workspace, 'encoding.txt'), /UTF-8/);
  await assert.rejects(readSource(workspace, 'binary.txt'), /UTF-8/);
  await assert.rejects(readSource(workspace, 'large.txt'), /2 MB/);
  const { revision } = await readSource(workspace, 'normal.txt');
  await assert.rejects(saveSource(workspace, 'normal.txt', '\0', revision), /UTF-8/);
  await assert.rejects(saveSource(workspace, 'normal.txt', 'a'.repeat(2 * 1024 * 1024 + 1), revision), /2 MB/);
  assert.equal(await fs.readFile(path.join(root, 'normal.txt'), 'utf8'), 'original');
});

async function run(t, workspace, name) {
  const { revision } = await readSource(workspace, name);
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const output = [];
  const controller = await startNodeRun(workspace, name, revision, event => {
    if (event.type === 'output') output.push(event.text);
    if (event.type === 'exit') finish(event);
  });
  t.after(() => controller.stop());
  const exit = await completed;
  return { exit, output: output.join('') };
}

test('JavaScript runner delivers both streams, preserves exit status, and rejects stale source', { timeout: 10_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const name = 'run (# % &).cjs';
  const script = path.join(root, name);
  await fs.writeFile(script, 'console.log("stdout café"); console.error("stderr ✓"); process.exitCode = 37;\n');
  const { exit, output } = await run(t, workspace, name);
  assert.equal(exit.code, 37);
  assert.equal(exit.location, null);
  assert.match(output, /stdout café/);
  assert.match(output, /stderr ✓/);

  const { revision } = await readSource(workspace, name);
  await fs.writeFile(script, 'throw new Error("external code must not run");');
  await assert.rejects(startNodeRun(workspace, name, revision, () => assert.fail('stale source ran')), /changed on disk/);
});

test('JavaScript runner keeps syntax and cross-file runtime diagnostics after large stderr output', { timeout: 10_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const directory = 'nested (source) # %';
  const target = path.join(directory, 'error (detail).cjs');
  await fs.mkdir(path.join(root, directory));
  await fs.writeFile(path.join(root, target), 'module.exports = function fail() {\n  throw new Error("cross-file");\n};\n');
  await fs.writeFile(path.join(root, 'run.cjs'), [
    'process.stderr.write("x".repeat(220000) + "\\n");',
    'require(' + JSON.stringify('./' + target.split(path.sep).join('/')) + ')();',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'syntax.mjs'), 'const invalid = ;\n');
  const runtime = await run(t, workspace, 'run.cjs');
  assert.equal(runtime.exit.code, 1);
  assert.deepEqual(runtime.exit.location, { path: target, line: 2, column: 9 });
  assert.equal(runtime.exit.summary, 'Error: cross-file');
  const syntax = await run(t, workspace, 'syntax.mjs');
  assert.equal(syntax.exit.code, 1);
  assert.deepEqual(syntax.exit.location, { path: 'syntax.mjs', line: 1, column: 17 });
  assert.match(syntax.exit.summary, /SyntaxError/);
});

test('draft writes retain the last acknowledged edit and isolate damaged records', async t => {
  const { folder, root } = await fixture(t);
  const directory = path.join(folder, 'drafts');
  const store = createDraftStore(directory);
  const revision = 'a'.repeat(64);
  await Promise.all([
    store.set(root, 'one.txt', 'earlier', revision),
    store.set(root, 'one.txt', 'latest', revision),
    store.set(root, 'two.txt', 'independent', revision),
  ]);
  await fs.writeFile(path.join(directory, 'b'.repeat(64) + '.json'), '{incomplete');
  const reopened = createDraftStore(directory);
  const { entries, unreadable } = await reopened.list();
  assert.equal(unreadable, true);
  assert.deepEqual(Object.fromEntries(entries.map(draft => [draft.path, draft.text])), {
    'one.txt': 'latest',
    'two.txt': 'independent',
  });
  await reopened.set(root, 'one.txt', null);
  assert.deepEqual((await reopened.list()).entries.map(draft => draft.path), ['two.txt']);
});

test('project search reads safe text and uses unsaved versions in place of disk copies', async t => {
  const { folder, root, workspace } = await fixture(t);
  const nested = 'nested (# % &)';
  const outside = path.join(folder, 'outside');
  for (const directory of [nested, 'node_modules', '.cache']) await fs.mkdir(path.join(root, directory));
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, nested, 'café.txt'), '\uFEFFskip\r\n  café [x+y]\r\n');
  await fs.writeFile(path.join(root, 'open.txt'), 'old [x+y]\n');
  await fs.writeFile(path.join(root, 'binary.txt'), Buffer.concat([Buffer.from('[x+y]'), Buffer.from([0])]));
  await fs.writeFile(path.join(root, 'node_modules', 'hidden.txt'), '[x+y]');
  await fs.writeFile(path.join(root, '.cache', 'hidden.txt'), '[x+y]');
  await fs.writeFile(path.join(outside, 'secret.txt'), '[x+y]');
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const { files, count, skipped } = await searchProject(workspace, '[x+y]', false, [
    { path: 'open.txt', documentId: 5, version: 8, text: 'updated [X+Y]\n' },
  ], new AbortController().signal);
  assert.equal(count, 2);
  assert.equal(skipped, 1);
  assert.deepEqual(files[0], {
    path: 'open.txt', documentId: 5, version: 8,
    matches: [{ line: 1, column: 9, length: 5, preview: 'updated [X+Y]' }],
  });
  assert.equal(files[1].path, path.join(nested, 'café.txt'));
  assert.match(files[1].revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(files[1].matches, [{ line: 2, column: 8, length: 5, preview: '  café [x+y]' }]);
  assert.equal((await searchProject(workspace, '[X+Y]', true, [], new AbortController().signal)).count, 0);
});

test('project search caps results, handles cancellation, and rejects an unsafe draft path', async t => {
  const { root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'many.txt'), 'token\n'.repeat(600));
  const result = await searchProject(workspace, 'token', false, [], new AbortController().signal);
  assert.equal(result.count, 400);
  assert.equal(result.limited, true);
  assert.equal(result.files[0].matches.at(-1).line, 400);

  const search = new AbortController();
  const pending = searchProject(workspace, 'token', false, [], search.signal);
  setImmediate(() => search.abort());
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(searchProject(workspace, 'token', false, [
    { path: '../outside.txt', documentId: 1, version: 0, text: 'token' },
  ], new AbortController().signal), /outside the workspace/);
});
