const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { generateKeyPairSync, sign } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { inspectExtensionPackage, sha256 } = require('../src/extensions/inspect-package.cjs');
const { createExtensionCatalog } = require('../src/extensions/catalog.cjs');
const { createExtensionManager } = require('../src/extensions/manager.cjs');
const { createExtensionRegistry } = require('../src/extensions/registry.cjs');
const { createOnlineCatalog } = require('../src/extensions/online-catalog.cjs');
const { createPreferences } = require('../src/preferences.cjs');
const { archive, executableManifest, json, manifest, minimalModule } = require('./extension-fixtures.cjs');
const { temporaryFolder } = require('./temp.cjs');

const exec = promisify(execFile);
const script = path.resolve(__dirname, '../scripts/pack-extension.cjs');
const pack = (source, output) => exec(process.execPath, [script, source, output], { windowsHide: true });

test('the packer produces identical inspected ZIPs from the same v1 and v2 source bytes', async t => {
  const root = await temporaryFolder(t, 'cevra-packaging-');
  const left = path.join(root, 'source café (#%)');
  const right = path.join(root, 'other source');
  await fs.mkdir(left);
  await fs.mkdir(right);
  for (const data of [manifest(), executableManifest([{ capability: 'commands.register' }])]) {
    for (const [index, source] of [left, right].entries()) {
      const manifestFile = path.join(source, 'extension.json');
      await fs.writeFile(manifestFile, json(data));
      await fs.writeFile(path.join(source, 'extension.wasm'), minimalModule);
      await fs.writeFile(path.join(source, 'README.txt'), `Different unrelated contents ${index}.`);
      const stamp = new Date(Date.UTC(2005 + index, 0, 1));
      await fs.utimes(manifestFile, stamp, stamp);
    }
    const a = path.join(root, `left-${data.schemaVersion}.zip`);
    const b = path.join(root, `right-${data.schemaVersion}.zip`);
    const [one, two] = await Promise.all([pack(left, a), pack(right, b)]);
    const bytes = await fs.readFile(a);
    assert.deepEqual(bytes, await fs.readFile(b));
    assert.equal(one.stdout, two.stdout);
    const report = await inspectExtensionPackage(a);
    assert.deepEqual(JSON.parse(one.stdout), report);
    assert.equal(report.sha256, sha256(bytes));
    assert.deepEqual(report.manifest, data);
    assert.deepEqual(report.inventory.map(entry => entry.path),
      data.schemaVersion === 1 ? ['extension.json'] : ['extension.json', 'extension.wasm']);
    await assert.rejects(pack(left, a), { code: 1, stderr: /^OUTPUT_EXISTS/ });
    assert.deepEqual(await fs.readFile(a), bytes);
  }
});

test('invalid inputs and incompatible packages produce no ZIP output', async t => {
  const root = await temporaryFolder(t, 'cevra-invalid-package-');
  const input = path.join(root, 'extension.json');
  const output = path.join(root, 'unwritten.zip');
  await fs.writeFile(input, '{invalid');
  await assert.rejects(pack(root, output), { code: 1, stderr: /^INVALID_MANIFEST/ });
  await fs.writeFile(input, json({ ...manifest(), engines: { cevra: '>=2.0.0 <3.0.0' } }));
  await assert.rejects(pack(root, output), { code: 1, stderr: /^INCOMPATIBLE_ENGINE/ });
  await fs.writeFile(input, json(executableManifest([{ capability: 'commands.register' }])));
  await assert.rejects(pack(root, output), { code: 1, stderr: /^PACKAGE_PATH/ });
  await fs.writeFile(path.join(root, 'extension.wasm'), 'bad module');
  await assert.rejects(pack(root, output), { code: 1, stderr: /^INVALID_ARCHIVE/ });
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
});

test('G7 lists the exact bundled releases and distinguishes unsupported executable activation', async () => {
  const catalog = createExtensionCatalog({ hostSupported: false });
  const view = await catalog.list();
  assert.equal(view.source, 'Bundled local catalog');
  assert.equal(view.hostSupported, false);
  assert.equal(view.error, undefined);
  assert.deepEqual(view.entries.map(({ displayName, category, permissionCount }) => [displayName, category, permissionCount]), [
    ['Starter Tools', 'Editing', 0], ['Hello Command', 'Commands', 1],
  ]);
  for (const entry of view.entries) {
    const { report, publisher } = await catalog.select(entry.id, entry.sha256);
    assert.equal(publisher, 'VOKRI Code project');
    assert.equal(report.sha256, entry.sha256);
    assert.equal(report.manifest.version, entry.version);
    assert.equal(report.publisher, 'unverified');
  }
  await assert.rejects(catalog.select(view.entries[0].id, '0'.repeat(64)), /changed or is unavailable/);
});

test('G7 catalog digest failures and failed updates keep the installed package intact', async t => {
  const root = await temporaryFolder(t, 'vokri-catalog-');
  const data = manifest();
  const old = path.join(root, 'old.zip');
  const previous = archive(data);
  await fs.writeFile(old, previous);
  const profile = path.join(root, 'profile');
  await fs.mkdir(profile);
  const registry = createExtensionRegistry(profile);
  await registry.install(old, { reviewedDigest: sha256(previous) });
  await registry.setEnabled(data.id, sha256(previous), true);

  const updated = { ...data, version: '2.0.0' };
  const file = path.join(root, updated.id + '-' + updated.version + '.zip');
  const expected = archive(updated);
  const release = { id: updated.id, version: updated.version, displayName: updated.displayName,
    description: updated.description, category: 'Editing', executable: false, sha256: sha256(expected) };
  const index = path.join(root, 'catalog.json');
  await fs.writeFile(index, json({ schemaVersion: 1, releases: [release] }));
  const catalog = createExtensionCatalog({ root, hostSupported: true });
  let view = await catalog.list();
  assert.match(view.entries[0].unavailable, /could not be opened or inspected/);
  await fs.writeFile(file, archive({ ...updated, description: 'Different valid bytes' }));
  view = await catalog.list();
  assert.match(view.entries[0].unavailable, /catalog digest/);
  await assert.rejects(catalog.select(release.id, release.sha256), /catalog digest/);
  await fs.writeFile(file, expected);
  let revocations = 0;
  const window = {};
  const manager = createExtensionManager({ catalog, registry, broker: { revoke: async () => { revocations++; } }, owner: () => window });
  const review = await manager.selectCatalog(release.id, release.sha256);
  assert.equal(review.update.direction, 'upgrade');
  assert.equal(review.current.sha256, sha256(previous));
  await fs.writeFile(file, archive({ ...updated, description: 'Different valid bytes' }));
  await assert.rejects(manager.install(review.token, false), /bytes changed after review/);
  assert.equal((await registry.list())[0].enabled, true);
  assert.equal((await registry.list())[0].sha256, sha256(previous));
  assert.equal(revocations, 0);
  await fs.writeFile(index, '{"schemaVersion":1,"schemaVersion":1,"releases":[]}');
  assert.match((await catalog.list()).error, /catalog is unavailable/);
});

test('G7 verifies the online signature, rejects replay and expiry, and binds reviewed downloads to their digest', async t => {
  const profile = await temporaryFolder(t, 'vokri-online-catalog-');
  const data = manifest();
  const archiveBytes = archive(data);
  const release = { id: data.id, version: data.version, displayName: data.displayName, description: data.description,
    category: 'Editing', executable: false, sha256: sha256(archiveBytes), engine: data.engines.cevra, permissionCount: 0 };
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const envelope = (generation, releases = [release], expiresAt = Date.now() + 3600_000) => {
    const payload = json({ schemaVersion: 1, generation, expiresAt, releases });
    return json({ payload: payload.toString('base64'), signature: sign(null, payload, key.privateKey).toString('base64') });
  };
  let feed = envelope(2);
  let downloaded = archiveBytes;
  const requests = [];
  const fetchBytes = async (url, limit) => {
    requests.push([new URL(url).protocol, new URL(url).hostname, new URL(url).pathname, limit]);
    return url.endsWith('/catalog.json') ? feed : downloaded;
  };
  const build = () => createOnlineCatalog({
    hostSupported: false, fetchBytes, publicKey, remember: createPreferences(profile).rememberExtensionCatalog,
  });
  const first = build();
  assert.equal((await first.list()).entries[0].sha256, release.sha256);
  await assert.rejects(first.select(release.id, '0'.repeat(64)), /unavailable/);
  downloaded = archive({ ...data, description: 'Unexpected bytes' });
  await assert.rejects(first.select(release.id, release.sha256), /SHA-256 check/);
  downloaded = archiveBytes;
  const registry = createExtensionRegistry(profile);
  const window = {};
  const manager = createExtensionManager({ onlineCatalog: first, registry, broker: {}, owner: () => window });
  const review = await manager.selectCatalog(release.id, release.sha256, 'online');
  assert.equal(review.source, 'Signed online catalog');
  assert.deepEqual(await registry.list(), []);
  assert.equal((await manager.install(review.token, false)).sha256, release.sha256);
  assert.equal((await registry.list())[0].enabled, false);
  assert.ok(requests.every(([protocol, hostname]) => protocol === 'https:' && hostname === 'raw.githubusercontent.com'));
  assert.ok(requests.some(([, , pathname]) => pathname.endsWith('/packages/' + release.sha256 + '.zip')));

  const restarted = build();
  feed = envelope(1);
  assert.match((await restarted.list()).error, /failed verification/);
  feed = envelope(2, [{ ...release, description: 'Equivocation' }]);
  assert.match((await restarted.list()).error, /failed verification/);
  feed = envelope(3, [release], Date.now() - 1000);
  assert.match((await restarted.list()).error, /failed verification/);
  const tampered = JSON.parse(envelope(3));
  tampered.payload = Buffer.from('different payload').toString('base64');
  feed = json(tampered);
  assert.match((await restarted.list()).error, /failed verification/);
  await assert.rejects(restarted.select(release.id, release.sha256), /unavailable/);
  feed = envelope(3);
  assert.equal((await restarted.list()).entries[0].id, release.id);
});
