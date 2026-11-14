const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { createWorkspace } = require('../src/workspace.cjs');
const { createPreferences } = require('../src/preferences.cjs');
const { createDraftStore } = require('../src/drafts.cjs');
const { createExtensionRegistry } = require('../src/extensions/registry.cjs');
const { createCapabilityBroker } = require('../src/extensions/broker.cjs');
const { createExtensionAudit } = require('../src/extensions/audit.cjs');
const { inspectExtensionPackage, sha256 } = require('../src/extensions/inspect-package.cjs');
const { executableManifest, executableArchive, minimalModule, json, zip } = require('./extension-fixtures.cjs');
const { temporaryFolder } = require('./temp.cjs');

const file = 'lib (#%)/café.js';
const source = 'const answer = 1;\n';
const replacement = 'const answer = 42;\n';
const allPermissions = [
  { capability: 'commands.register' }, { capability: 'workspace.read', files: [file], drafts: true },
  { capability: 'editor.readSelection', files: [file] }, { capability: 'diagnostics.publish', files: [file] },
  { capability: 'editor.proposeEdit', files: [file] },
];

async function fixture(t, options = {}) {
  const root = await temporaryFolder(t, 'cevra-broker-');
  const projectRoot = path.join(root, 'workspace (#%) & café');
  const profile = path.join(root, 'profile');
  await fs.mkdir(path.join(projectRoot, 'lib (#%)'), { recursive: true });
  await fs.mkdir(profile);
  await fs.writeFile(path.join(projectRoot, file), source);
  await fs.writeFile(path.join(projectRoot, 'private.txt'), 'PRIVATE_SOURCE_MARKER');
  let project = await createWorkspace(projectRoot);
  const preferences = createPreferences(profile);
  await preferences.setTrusted(project, true);
  const registry = createExtensionRegistry(profile);
  const manifest = executableManifest(options.permissions ?? allPermissions);
  const filename = path.join(root, 'extension.zip');
  const bytes = executableArchive(manifest);
  const digest = sha256(bytes);
  await fs.writeFile(filename, bytes);
  await registry.install(filename, { reviewedDigest: digest });
  await registry.setEnabled(manifest.id, digest, true);
  const hosts = [];
  let editor = { path: file, text: source, baseRevision: sha256(source), documentId: 1, version: 0, selection: { from: 6, to: 12 } };
  let editorReads = 0;
  let reviews = 0;
  const audit = createExtensionAudit(profile);
  const broker = createCapabilityBroker({ registry, audit, getWorkspace: () => project,
    isTrusted: current => preferences.isTrusted(current),
    consent: async details => { reviews++; return options.consent ? options.consent(details) : true; },
    editorSnapshot: async (...args) => { editorReads++; return options.editorSnapshot ? options.editorSnapshot(...args) : editor; },
    safeStart: options.safeStart, supported: options.supported,
    startHost: async request => {
      let finish;
      let sequence = 0;
      const host = { stopped: false, closed: new Promise(resolve => { finish = resolve; }),
        activate: async () => {}, invoke: async () => 0, ping: async () => {},
        stop: async () => { host.stopped = true; finish({ code: 0 }); },
        request: async (method, params = {}, requestId = String(++sequence)) =>
          JSON.parse(await request(Buffer.from(JSON.stringify({ protocol: 1, requestId, method, params })))),
        raw: bytes => request(bytes),
      };
      hosts.push(host);
      return host;
    },
  });
  t.after(() => broker.close());
  const activate = () => broker.activate(manifest.id, digest);
  const read = () => hosts.at(-1).request('workspace.readFile', { path: file, source: 'disk' });
  const proposal = async () => {
    const { result } = await read();
    const answer = await hosts.at(-1).request('editor.proposeEdit', { fileHandle: result.fileHandle,
      expectedRevision: result.revision, proposedText: replacement, explanation: 'Correct the answer' });
    assert.equal(answer.ok, true);
    return answer.result.proposalId;
  };
  return { root, profile, projectRoot, registry, broker, preferences, manifest, digest, filename, hosts, activate, read, proposal,
    get project() { return project; }, setProject: value => { project = value; },
    setEditor: value => { editor = value; }, editorReads: () => editorReads, reviews: () => reviews };
}

test('v2 executable packages inspect exact inventory and reject inconsistent module and permission declarations', async t => {
  const f = await fixture(t);
  const report = await inspectExtensionPackage(f.filename);
  assert.equal(report.format, 'cevra-zip-v2');
  assert.deepEqual(report.inventory.map(item => item.path), ['extension.json', 'extension.wasm']);
  assert.deepEqual((await f.registry.executable(f.manifest.id, f.digest)).module, minimalModule);
  const invalid = [
    executableArchive({ ...f.manifest, permissions: [{ capability: 'network.request' }] }),
    executableArchive({ ...f.manifest, permissions: [{ capability: 'workspace.read', files: ['../private'] }] }),
    executableArchive({ ...f.manifest, permissions: [{ capability: 'workspace.read', files: ['file:stream'] }] }),
    executableArchive({ ...f.manifest, permissions: [{ capability: 'workspace.read', files: [file, file.toUpperCase()] }] }),
    executableArchive({ ...f.manifest, runtime: { apiVersion: '99', entry: 'extension.wasm' } }),
    executableArchive(f.manifest, Buffer.from('invalid module')),
    zip([{ bytes: json(f.manifest) }, { name: '../extension.wasm', bytes: minimalModule }]),
    zip([{ bytes: json(f.manifest) }, { name: 'extension.wasm', bytes: minimalModule, attributes: 0xa1ff0000 }]),
  ];
  for (const bytes of invalid) {
    await fs.writeFile(f.filename, bytes);
    await assert.rejects(inspectExtensionPackage(f.filename));
  }
});

test('consent denial, untrusted workspaces, safe start and unsupported platforms start no host', async t => {
  for (const options of [{ consent: () => false }, { safeStart: true }, { supported: false }, {}]) {
    await t.test(JSON.stringify(options), async t => {
      const f = await fixture(t, options);
      if (!Object.keys(options).length) await f.preferences.setTrusted(f.project, false);
      const result = await f.activate().catch(error => error.code);
      assert.ok(result === false || result === 'PERMISSION_DENIED');
      assert.equal(f.hosts.length, 0);
      assert.equal(f.broker.snapshot().sessions.length, 0);
    });
  }
});

test('broker grants only declared file scopes and distinguishes saved source, draft source and selection', async t => {
  const f = await fixture(t);
  await f.activate();
  const host = f.hosts[0];
  const saved = await f.read();
  assert.equal(saved.ok, true);
  assert.equal(saved.result.text, source);
  assert.equal(saved.result.source, 'disk');
  const denied = await host.request('workspace.readFile', { path: 'private.txt', source: 'disk' });
  assert.equal(denied.error.code, 'PERMISSION_DENIED');
  assert.ok(!JSON.stringify(denied).includes('PRIVATE_SOURCE_MARKER'));
  f.setEditor({ path: file, text: replacement, baseRevision: sha256(source), documentId: 2, version: 4, selection: { from: 6, to: 12 } });
  const draft = await host.request('workspace.readFile', { path: file, source: 'draft' });
  assert.equal(draft.result.text, replacement);
  assert.equal(draft.result.source, 'draft');
  assert.notEqual(draft.result.revision, saved.result.revision);
  const selected = await host.request('editor.readSelection');
  assert.equal(selected.result.text, 'answer');
  assert.deepEqual(selected.result.selection, { from: 6, to: 12 });
  assert.equal(await fs.readFile(path.join(f.projectRoot, file), 'utf8'), source);
});

test('undeclared operations are denied before the editor service is accessed', async t => {
  const f = await fixture(t, { permissions: [{ capability: 'commands.register' }] });
  await f.activate();
  for (const [method, params] of [['editor.readSelection', {}], ['workspace.readFile', { path: file, source: 'disk' }]]) {
    assert.equal((await f.hosts[0].request(method, params)).error.code, 'PERMISSION_DENIED');
  }
  assert.equal(f.editorReads(), 0);
});

test('revocation discards a pending source response, removes registrations and makes old handles unusable', async t => {
  let release;
  let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { editorSnapshot: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  await f.activate();
  await f.hosts[0].request('commands.register', { id: 'hello', title: 'Hello', handler: 0 });
  assert.equal(f.broker.snapshot().sessions[0].commands.length, 1);
  const read = f.hosts[0].request('workspace.readFile', { path: file, source: 'draft' });
  await pending;
  await f.broker.revoke(f.manifest.id);
  release({ path: file, text: source, baseRevision: sha256(source), documentId: 1, version: 0 });
  assert.equal((await read).error.code, 'STALE_SESSION');
  assert.equal(f.hosts[0].stopped, true);
  assert.deepEqual(f.broker.snapshot().sessions, []);
  assert.equal((await f.read()).error.code, 'STALE_SESSION');
});

test('workspace switch and replacement, trust revocation, and package updates invalidate prior sessions', async t => {
  for (const action of ['switch', 'replace', 'trust', 'update', 'disable', 'quarantine', 'remove']) {
    await t.test(action, async t => {
      const f = await fixture(t);
      await f.activate();
      if (action === 'switch') {
        const other = path.join(f.root, 'other workspace');
        await fs.mkdir(path.dirname(path.join(other, file)), { recursive: true });
        await fs.writeFile(path.join(other, file), 'other workspace source');
        await f.broker.suspend();
        f.setProject(await createWorkspace(other));
        await f.preferences.setTrusted(f.project, true);
      }
      if (action === 'replace') {
        await fs.rename(f.projectRoot, f.projectRoot + ' original');
        await fs.mkdir(f.projectRoot);
      }
      if (action === 'trust') await f.preferences.setTrusted(f.project, false);
      if (action === 'update') {
        const bytes = executableArchive({ ...f.manifest, version: '2.0.0' });
        await fs.writeFile(f.filename, bytes);
        await f.registry.install(f.filename, { reviewedDigest: sha256(bytes), expectedCurrent: f.digest });
      }
      if (action === 'disable') await f.registry.setEnabled(f.manifest.id, f.digest, false);
      if (action === 'quarantine') await f.registry.quarantine(f.manifest.id, f.digest);
      if (action === 'remove') await f.registry.remove(f.manifest.id, f.digest);
      const response = await f.read();
      assert.equal(response.ok, false);
      assert.ok(['STALE_SESSION', 'PERMISSION_DENIED'].includes(response.error.code));
    });
  }
});

test('a second host cannot reuse another extension file handle or command registration', async t => {
  const f = await fixture(t);
  await f.activate();
  const first = f.hosts[0];
  const read = (await f.read()).result;
  const command = (await first.request('commands.register', { id: 'hello', title: 'Hello', handler: 0 })).result;
  const other = { ...f.manifest, id: 'org.cevra.second' };
  const bytes = executableArchive(other);
  const digest = sha256(bytes);
  await fs.writeFile(f.filename, bytes);
  await f.registry.install(f.filename, { reviewedDigest: digest });
  await f.registry.setEnabled(other.id, digest, true);
  await f.broker.activate(other.id, digest);
  assert.equal((await f.hosts[1].request('diagnostics.publish', {
    fileHandle: read.fileHandle, expectedRevision: read.revision, items: [],
  })).error.code, 'PERMISSION_DENIED');
  await assert.rejects(f.broker.invoke(other.id, command.registrationId), { code: 'STALE_SESSION' });
  assert.equal((await first.request('workspace.readFile', { path: file, source: 'disk' })).result.text, source);
});

test('workspace and enablement changes during consent cannot activate the prior review', async t => {
  for (const change of ['workspace', 'enablement']) {
    await t.test(change, async t => {
      let approve;
      let entered;
      const review = new Promise(resolve => { entered = resolve; });
      const f = await fixture(t, { consent: () => { entered(); return new Promise(resolve => { approve = resolve; }); } });
      const activation = f.activate();
      await review;
      if (change === 'workspace') await f.broker.suspend();
      else {
        await f.registry.setEnabled(f.manifest.id, f.digest, false);
        await f.registry.setEnabled(f.manifest.id, f.digest, true);
      }
      approve(true);
      await assert.rejects(activation, { code: 'STALE_SESSION' });
      assert.equal(f.hosts.length, 0);
    });
  }
});

test('commands are namespaced and diagnostics and proposals require the current source revision', async t => {
  const f = await fixture(t);
  await f.activate();
  const host = f.hosts[0];
  const registration = await host.request('commands.register', { id: 'hello', title: '<Hello>', handler: 0 });
  assert.equal(f.broker.snapshot().sessions[0].commands[0].id, f.manifest.id + '.hello');
  assert.equal(await f.broker.invoke(f.manifest.id, registration.result.registrationId), 0);
  const { result } = await f.read();
  const diagnostic = { fileHandle: result.fileHandle, expectedRevision: result.revision,
    items: [{ from: 0, to: 5, severity: 'warning', message: 'Review answer' }] };
  assert.equal((await host.request('diagnostics.publish', diagnostic)).ok, true);
  const proposalId = await f.proposal();
  assert.equal((await f.broker.proposal(f.manifest.id, proposalId)).original, source);
  await fs.writeFile(path.join(f.projectRoot, file), 'external edit\n');
  assert.equal((await host.request('diagnostics.publish', diagnostic)).error.code, 'STALE_REVISION');
  await assert.rejects(f.broker.proposal(f.manifest.id, proposalId), { code: 'STALE_REVISION' });
  f.broker.documentChanged(f.project.id, file);
  assert.deepEqual(f.broker.snapshot().sessions[0].diagnostics, []);
  assert.deepEqual(f.broker.snapshot().sessions[0].proposals, []);
});

test('approved edits create recoverable drafts and revision changes reject before any draft commit', async t => {
  const f = await fixture(t);
  const drafts = createDraftStore(path.join(f.profile, 'drafts'));
  await f.activate();
  const id = await f.proposal();
  const changes = [{ path: file, text: replacement, revision: sha256(source) }];
  await f.broker.commitProposal(f.manifest.id, id, changes,
    beforeCommit => drafts.setMany(f.projectRoot, changes, { beforeCommit }));
  assert.equal((await drafts.list()).entries[0].text, replacement);
  assert.equal(await fs.readFile(path.join(f.projectRoot, file), 'utf8'), source);
  const stale = await f.proposal();
  await fs.writeFile(path.join(f.projectRoot, file), 'external change');
  let commits = 0;
  await assert.rejects(f.broker.commitProposal(f.manifest.id, stale, changes, () => { commits++; }), { code: 'STALE_REVISION' });
  assert.equal(commits, 0);
});

test('revocation wins before the draft commit check and an already committed draft survives later revocation', async t => {
  const f = await fixture(t);
  await f.activate();
  const id = await f.proposal();
  let release;
  let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  let committed = false;
  const committing = f.broker.commitProposal(f.manifest.id, id, [{ path: file, text: replacement, revision: sha256(source) }],
    async check => { entered(); await new Promise(resolve => { release = resolve; }); await check(); committed = true; });
  await pending;
  const revoke = f.broker.revoke(f.manifest.id);
  release();
  await assert.rejects(committing, { code: 'STALE_SESSION' });
  await revoke;
  assert.equal(committed, false);
  await f.activate();
  const next = await f.proposal();
  await f.broker.commitProposal(f.manifest.id, next, [{ path: file, text: replacement, revision: sha256(source) }],
    async check => { await check(); committed = true; });
  await f.broker.revoke(f.manifest.id);
  assert.equal(committed, true);
});

test('replayed requests, unknown methods, malformed frames and registration floods stop the offending host', async t => {
  for (const action of ['replay', 'unknown', 'intelligence', 'malformed', 'duplicate', 'oversize', 'registrations']) {
    await t.test(action, async t => {
      const f = await fixture(t);
      await f.activate();
      const host = f.hosts[0];
      let result;
      if (action === 'replay') {
        await host.request('workspace.readFile', { path: file, source: 'disk' }, 'same');
        result = await host.request('workspace.readFile', { path: file, source: 'disk' }, 'same');
      }
      if (action === 'unknown') result = await host.request('network.request', { secret: 'CREDENTIAL_MARKER' });
      if (action === 'intelligence') result = await host.request('intelligence.readCredential', { provider: 'openai' });
      if (action === 'malformed') result = JSON.parse(await host.raw(Buffer.from('{invalid')));
      if (action === 'duplicate') result = JSON.parse(await host.raw(Buffer.from(
        '{"protocol":1,"requestId":"example","method":"editor.readSelection","method":"commands.register","params":{}}')));
      if (action === 'oversize') result = JSON.parse(await host.raw(Buffer.alloc(256 * 1024 + 1)));
      if (action === 'registrations') {
        for (let index = 0; index < 17; index++) result = await host.request('commands.register', { id: 'hello-' + index, title: 'Hello', handler: 0 });
      }
      assert.equal(result.ok, false);
      assert.ok(['INVALID_REQUEST', 'QUOTA'].includes(result.error.code));
      assert.equal(host.stopped, true);
      assert.deepEqual(f.broker.snapshot().sessions, []);
    });
  }
});

test('persisted audit contains bounded metadata and excludes source, paths, file handles and host parameters', async t => {
  const f = await fixture(t);
  await f.activate();
  const { result } = await f.read();
  await f.hosts[0].request('workspace.readFile', { path: 'private.txt', source: 'disk' });
  await f.hosts[0].request('network.request', { secret: 'CREDENTIAL_MARKER' });
  await f.broker.close();
  const bytes = await fs.readFile(path.join(f.profile, 'extensions', 'audit.json'), 'utf8');
  const audit = JSON.parse(bytes);
  assert.ok(audit.events.some(event => event.result === 'denied'));
  assert.ok(audit.events.every(event => event.workspace.length === 64 && event.digest.length === 12));
  for (const marker of [source.trim(), f.projectRoot, file, result.fileHandle, 'PRIVATE_SOURCE_MARKER', 'CREDENTIAL_MARKER']) {
    assert.ok(!bytes.includes(marker), marker);
  }
});

test('an unreadable audit fails closed before source disclosure', async t => {
  const f = await fixture(t);
  await f.activate();
  await fs.writeFile(path.join(f.profile, 'extensions', 'audit.json'), 'damaged');
  const response = await f.read();
  assert.equal(response.error.code, 'AUDIT_UNAVAILABLE');
  assert.equal(f.hosts[0].stopped, true);
});
