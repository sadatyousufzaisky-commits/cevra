const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { createDraftStore } = require('../src/drafts.cjs');
const { createContextBroker } = require('../src/intelligence/context-broker.cjs');
const { createPatchBroker, parsePatch } = require('../src/intelligence/patch-broker.cjs');
const { normalizeSource } = require('../src/source-text.cjs');
const { createWorkspace, readSource } = require('../src/workspace.cjs');
const { temporaryFolder } = require('./temp.cjs');

const packet = (...edits) => JSON.stringify({ schemaVersion: 1, edits });
const edit = (source, replacement) => ({ source, replacement });

async function setup(t) {
  const temp = await temporaryFolder(t, 'cevra-intelligence-patch-');
  const root = path.join(temp, 'project (QA) & café');
  const file = 'main.js';
  const helper = 'helper.js';
  const original = '\uFEFFconst first = 1;\r\nconst old = 2;\r\n';
  const draft = '\uFEFFconst first = 1;\r\nconst draft = "café 🌱";\r\n';
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, file), original);
  await fs.writeFile(path.join(root, helper), 'export const value = 1;\n');
  const project = await createWorkspace(root);
  const controller = new AbortController();
  const drafts = createDraftStore(path.join(temp, 'drafts'));
  const { revision } = await readSource(project, file);
  const normalized = normalizeSource(draft);
  const snapshot = { path: file, text: draft, baseRevision: revision, documentId: 1, version: 2, lineEnding: '\r\n',
    selection: { from: normalized.indexOf('const draft'), to: normalized.lastIndexOf('\n') } };
  let visible;
  const context = createContextBroker(project, {
    current: value => project === value,
    readEditor: async (_project, requested) => requested === file ? { ...snapshot, text: normalized } : null,
  });
  const selection = await context.attachSelection({ ...snapshot, text: normalized });
  const saved = await context.attachSaved(helper, 'file');
  const sources = context.items();
  const broker = createPatchBroker({ current: () => project,
    readEditor: async (_project, requested) => requested === file ? snapshot : null, changed: value => { visible = value; } });
  const raw = packet(edit(selection.id, 'const draft = 4;'), edit(saved.id, 'export const value = 2;\n'));
  return { root, file, helper, original, project, drafts, broker, controller, selection, visible: () => visible,
    issue: (reply = raw) => broker.issue(project, reply, sources, () => context.verify(sources, controller.signal), controller.signal),
    changes: [
      { path: file, revision, text: '\uFEFFconst first = 1;\r\nconst draft = 4;\r\n' },
      { path: helper, revision: (await readSource(project, helper)).revision, text: 'export const value = 2;\n' },
    ],
  };
}

test('patch output is restricted to issued source IDs and one bounded normalized replacement per file', () => {
  const allowed = [{ id: 'selection', kind: 'selection', path: 'a.js', text: 'old' },
    { id: 'file', kind: 'file', path: 'a.js', text: 'old' },
    { id: 'instructions', kind: 'instructions', path: '.cevra/ai-instructions.md', text: 'instructions' }];
  for (const raw of [
    'not JSON', packet(edit('../outside.js', 'x')), packet(edit('instructions', 'x')),
    packet(edit('selection', 'new'), edit('file', 'other')), packet(edit('selection', 'x\r\ny')),
    packet(edit('selection', 'old')), packet(edit('selection', '\u0000')), packet(edit('selection', '\ud800')),
    packet({ ...edit('selection', 'x'), path: 'a.js' }), packet(edit('selection', 'x'.repeat(24 * 1024))),
  ]) assert.throws(() => parsePatch(raw, allowed), /valid edit proposal/i);
  assert.equal(parsePatch(packet(edit('selection', '')), allowed)[0].replacement, '');
});

test('a reviewed multi-file proposal commits exact bytes as recoverable drafts once', async t => {
  const f = await setup(t);
  const id = await f.issue();
  const commit = (review, changes) => f.broker.commit(f.project, id, review, changes,
    beforeCommit => f.drafts.setMany(f.root, changes, { beforeCommit }));
  assert.equal(f.visible().fileCount, 2);
  assert.deepEqual((await f.drafts.list()).entries, []);
  await assert.rejects(commit(undefined, f.changes), /open the intelligence diff/i);
  const preview = await f.broker.preview(f.project, id);
  assert.equal(preview.files[0].documentId, 1);
  assert.equal(preview.files[1].matches[0].replacement, f.changes[1].text);
  await assert.rejects(commit(preview.authority.review, [{ ...f.changes[0], text: 'tampered' }, f.changes[1]]), /differs/i);
  await commit(preview.authority.review, f.changes);
  assert.equal(await fs.readFile(path.join(f.root, f.file), 'utf8'), f.original);
  const recovered = (await f.drafts.list()).entries.sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(recovered.map(({ path, text }) => [path, text]),
    [...f.changes].sort((a, b) => a.path.localeCompare(b.path)).map(({ path, text }) => [path, text]));
  await assert.rejects(commit(preview.authority.review, f.changes), /expired/i);
  assert.equal(f.visible(), null);
});

test('a disk change at the journal boundary prevents every file in the proposal from being drafted', async t => {
  const f = await setup(t);
  const id = await f.issue();
  const { authority } = await f.broker.preview(f.project, id);
  await assert.rejects(f.broker.commit(f.project, id, authority.review, f.changes, async beforeCommit => {
    await fs.writeFile(path.join(f.root, f.helper), 'changed during staging\n');
    await f.drafts.setMany(f.root, f.changes, { beforeCommit });
  }), /source changed/i);
  assert.deepEqual((await f.drafts.list()).entries, []);
  assert.equal(await fs.readFile(path.join(f.root, f.file), 'utf8'), f.original);
});

test('a selection shows an inline proposal and revocation invalidates a review at the journal boundary', async t => {
  const f = await setup(t);
  const id = await f.issue(packet(edit(f.selection.id, 'const draft = 4;')));
  assert.equal(f.visible().inline.text, 'const draft = 4;');
  const { authority } = await f.broker.preview(f.project, id);
  const changes = f.changes.slice(0, 1);
  await assert.rejects(f.broker.commit(f.project, id, authority.review, changes, beforeCommit => {
    f.broker.documentChanged(f.project, f.file);
    return f.drafts.setMany(f.root, changes, { beforeCommit });
  }), /expired/i);
  assert.deepEqual((await f.drafts.list()).entries, []);
  const dismissed = await f.issue(packet(edit(f.selection.id, 'const draft = 4;')));
  f.broker.dismiss(f.project, dismissed);
  await assert.rejects(f.broker.preview(f.project, dismissed), /expired/i);
  const revoked = await f.issue(packet(edit(f.selection.id, 'const draft = 4;')));
  f.controller.abort();
  await assert.rejects(f.broker.preview(f.project, revoked), /expired/i);
});
