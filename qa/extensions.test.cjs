const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { crc32, deflateRawSync } = require('node:zlib');
const { inspectExtensionPackage } = require('../src/extensions/inspect-package.cjs');
const { version: engineVersion } = require('../package.json');
const { temporaryFolder } = require('./temp.cjs');

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestName = 'extension.json';
const cli = path.resolve(__dirname, '..', 'scripts', 'inspect-extension.cjs');

function manifest(contributes = { snippets: [{ id: 'say-hello', language: 'javascript', prefix: 'hi', body: 'console.log("hello")\n' }] }) {
  return {
    schemaVersion: 1, id: 'org.cevra.hello', version: '1.2.0', displayName: 'Hello café',
    description: 'Declarative example', engines: { cevra: '>=0.1.0 <1.0.0' }, permissions: [], contributes,
  };
}

function zip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const { name = manifestName, bytes, method = 0, attributes = 0x81a40020 } of entries) {
    const filename = Buffer.from(name);
    const payload = method === 8 ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method === 8 ? 20 : 10, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    local.copy(central, 6, 4, 28);
    central.writeUInt32LE(attributes, 38);
    central.writeUInt32LE(offset, 42);
    localRecords.push(local, filename, payload);
    centralRecords.push(central, filename);
    offset += local.length + filename.length + payload.length;
  }
  const directory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, directory, end]);
}

const json = value => Buffer.from(JSON.stringify(value));
const archive = (data = manifest(), entry = {}) => zip([{ bytes: Buffer.isBuffer(data) ? data : json(data), ...entry }]);
const directoryOffset = bytes => bytes.readUInt32LE(bytes.length - 6);

function change(bytes, mutate) {
  const copy = Buffer.from(bytes);
  mutate(copy, directoryOffset(copy));
  return copy;
}

async function fixture(t) {
  const root = await temporaryFolder(t, 'cevra-ext-');
  const folder = path.join(root, 'packages (QA) & café [#%]');
  await fs.mkdir(folder);
  const file = path.join(folder, 'local package & café [#%].zip');
  return {
    root, folder, file,
    async inspect(bytes) {
      await fs.writeFile(file, bytes);
      return inspectExtensionPackage(file);
    },
  };
}

test('extension inspection reports exact bytes for independent snippet and theme packages', async t => {
  const { inspect, file } = await fixture(t);
  const samples = [
    manifest(),
    manifest({ themes: [{ id: 'quiet-night', label: 'Quiet Night',
      colors: { background: '#151925', foreground: '#E9EEF7', accent: '#7D9AFF' } }] }),
  ];
  for (const [index, data] of samples.entries()) {
    const bytes = archive(data, { method: index ? 8 : 0 });
    const report = await inspect(bytes);
    assert.deepEqual(report, {
      format: 'cevra-zip-v1', engineVersion, sha256: digest(bytes), publisher: 'unverified',
      manifest: data,
      inventory: [{ path: manifestName, bytes: json(data).length, sha256: digest(json(data)) }],
    });
    assert.deepEqual(await inspectExtensionPackage(file), report);
    assert.deepEqual(await fs.readFile(file), bytes);
  }
  const stored = await inspect(archive(samples[0]));
  const compressed = await inspect(archive(samples[0], { method: 8 }));
  assert.notEqual(stored.sha256, compressed.sha256);
  assert.deepEqual(stored.inventory, compressed.inventory);
});

test('the inspection CLI reads a selected package without creating files or running contributions', async t => {
  const { folder, root, file } = await fixture(t);
  const workspace = path.join(root, 'workspace');
  const profile = path.join(root, 'profile');
  await fs.mkdir(workspace);
  await fs.mkdir(profile);
  const sentinel = path.join(workspace, 'draft.txt');
  await fs.writeFile(sentinel, 'unsaved draft baseline\n');
  const data = manifest();
  data.contributes.snippets[0].body = 'require("node:fs").writeFileSync("unexpected.txt", "started")';
  await fs.writeFile(file, archive(data));
  const options = { cwd: workspace, windowsHide: true, env: { ...process.env, APPDATA: profile, LOCALAPPDATA: profile } };
  const report = await execute(process.execPath, [cli, file], options);
  assert.equal(JSON.parse(report.stdout).manifest.id, data.id);
  assert.equal(report.stderr, '');
  await fs.writeFile(file, archive({ ...data, main: 'index.js' }));
  await assert.rejects(execute(process.execPath, [cli, file], options), error =>
    error.code === 1 && error.stdout === '' && /^INVALID_MANIFEST /.test(error.stderr));
  await assert.rejects(execute(process.execPath, [cli], options), error =>
    error.code === 2 && /^Usage: /.test(error.stderr));
  assert.deepEqual(await fs.readdir(workspace), ['draft.txt']);
  assert.deepEqual(await fs.readdir(folder), [path.basename(file)]);
  assert.deepEqual(await fs.readdir(profile), []);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unsaved draft baseline\n');
});

test('ZIP inspection rejects extra or ambiguous entries and unsupported paths', async t => {
  const { inspect } = await fixture(t);
  const bytes = json(manifest());
  for (const entries of [
    [],
    [{ bytes }, { bytes }],
    [{ bytes }, { bytes, name: 'Extension.json' }],
    [{ bytes }, { bytes: Buffer.from('plain data'), name: 'README.md' }],
    ...['Extension.json', '../extension.json', 'nested/extension.json', 'extension.json:stream',
      'extension.json\0', '/extension.json', 'C:/extension.json', 'extension.json/'].map(name => [{ bytes, name }]),
  ]) {
    await assert.rejects(inspect(zip(entries)), { code: 'INVALID_ARCHIVE' });
  }
});

test('ZIP inspection rejects unsupported file types, formats and metadata', async t => {
  const { inspect } = await fixture(t);
  const valid = archive();
  for (const bytes of [
    archive(manifest(), { attributes: 0xa1ff0000 }),
    archive(manifest(), { attributes: 0x4000 }),
    archive(manifest(), { attributes: 0x10 }),
    change(valid, (b, d) => { b.writeUInt16LE(1, 6); b.writeUInt16LE(1, d + 8); }),
    change(valid, (b, d) => { b.writeUInt16LE(8, 6); b.writeUInt16LE(8, d + 8); }),
    change(valid, (b, d) => { b.writeUInt16LE(45, 4); b.writeUInt16LE(45, d + 6); }),
    change(valid, (b, d) => b.writeUInt16LE(1, d + 30)),
    change(valid, (b, d) => b.writeUInt16LE(1, d + 32)),
    change(valid, (b, d) => { b.writeUInt16LE(99, 8); b.writeUInt16LE(99, d + 10); }),
    change(valid, b => b.writeUInt16LE(1, b.length - 18)),
  ]) {
    await assert.rejects(inspect(bytes), { code: 'INVALID_ARCHIVE' });
  }
});

test('ZIP inspection rejects inconsistent headers, hidden bytes, truncation and CRC mismatches', async t => {
  const { inspect } = await fixture(t);
  const valid = archive();
  for (const bytes of [
    change(valid, b => b.writeUInt32LE(0, 0)),
    change(valid, (b, d) => b.writeUInt32LE(1, d + 42)),
    change(valid, (b, d) => b.writeUInt32LE(1, d + 20)),
    change(valid, (b, d) => { b.writeUInt32LE(1, 14); b.writeUInt32LE(1, d + 16); }),
    change(valid, (b, d) => b[d + 46] = 0x58),
    change(valid, b => b.writeUInt32LE(0xffffffff, b.length - 6)),
    valid.subarray(0, valid.length - 1),
    Buffer.concat([Buffer.of(0), valid]),
    Buffer.concat([valid, Buffer.of(0)]),
  ]) {
    await assert.rejects(inspect(bytes), { code: 'INVALID_ARCHIVE' });
  }
});

test('package, manifest and inflate limits reject before accepting a descriptor', async t => {
  const { inspect } = await fixture(t);
  await assert.rejects(inspect(Buffer.alloc(256 * 1024 + 1)), { code: 'PACKAGE_TOO_LARGE' });
  await assert.rejects(inspect(archive(Buffer.alloc(128 * 1024 + 1, 0x20), { method: 8 })), { code: 'MANIFEST_TOO_LARGE' });
  const compressed = archive(manifest(), { method: 8 });
  await assert.rejects(inspect(change(compressed, (b, d) => {
    b.writeUInt32LE(8, 22);
    b.writeUInt32LE(8, d + 24);
  })), { code: 'INVALID_ARCHIVE', message: /exceeds its declared size/ });
  const directory = directoryOffset(compressed);
  const trailing = Buffer.concat([compressed.subarray(0, directory), Buffer.of(0), compressed.subarray(directory)]);
  trailing.writeUInt32LE(directory + 1, trailing.length - 6);
  trailing.writeUInt32LE(compressed.readUInt32LE(18) + 1, 18);
  trailing.writeUInt32LE(compressed.readUInt32LE(18) + 1, directory + 21);
  await assert.rejects(inspect(trailing), { code: 'INVALID_ARCHIVE', message: /trailing data/ });
});

test('manifest parsing rejects duplicate keys even with escaped spellings and nested fields', async t => {
  const { inspect } = await fixture(t);
  const raw = JSON.stringify(manifest());
  for (const source of [
    raw.replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1'),
    raw.replace('"id":"org.cevra.hello"', '"id":"org.other.id","\\u0069d":"org.cevra.hello"'),
    raw.replace('"prefix":"hi"', '"prefix":"no","prefix":"hi"'),
  ]) {
    await assert.rejects(inspect(archive(Buffer.from(source))), { code: 'INVALID_MANIFEST', message: /duplicate/ });
  }
  const data = manifest();
  data.contributes.snippets[0].body = 'const item = { "prefix": "hi", "prefix": "hello" };\n';
  assert.deepEqual((await inspect(archive(data))).manifest, data);
});

test('manifest parsing rejects malformed text, unsafe labels, and over-nested JSON', async t => {
  const { inspect } = await fixture(t);
  for (const bytes of [
    Buffer.from([0xff]), Buffer.from('\uFEFF' + JSON.stringify(manifest())), Buffer.from('{'),
    Buffer.from('['.repeat(9) + '0' + ']'.repeat(9)),
    json({ ...manifest(), displayName: 'title\u202e' }),
    json({ ...manifest(), displayName: '\ud800' }),
    json({ ...manifest(), displayName: '  ' }),
    json({ ...manifest(), description: 'a'.repeat(321) }),
  ]) await assert.rejects(inspect(archive(bytes)), { code: 'INVALID_MANIFEST' });
});

test('manifest v1 rejects execution fields, permissions, unsupported values and ambiguous contribution IDs', async t => {
  const { inspect } = await fixture(t);
  const snippet = manifest().contributes.snippets[0];
  const theme = { id: 'sunset', label: 'Sunset', colors: { background: '#151925', foreground: '#E9EEF7', accent: '#7D9AFF' } };
  for (const data of [
    { ...manifest(), schemaVersion: 2 },
    { ...manifest(), id: 'Org.cevra.demo' },
    { ...manifest(), version: '1.02.0' },
    { ...manifest(), version: '1234567890.0.0' },
    { ...manifest(), activationEvents: ['onStartup'] },
    { ...manifest(), permissions: ['workspace.read'] },
    manifest({ commands: [] }),
    manifest({}),
    manifest({ snippets: Array(33).fill(snippet) }),
    manifest({ snippets: [snippet, { ...snippet, prefix: 'hello' }] }),
    manifest({ snippets: [{ ...snippet, language: 'custom' }] }),
    manifest({ snippets: [{ ...snippet, body: 'x'.repeat(2049) }] }),
    manifest({ snippets: [{ ...snippet, body: 'print\u0007' }] }),
    manifest({ themes: [theme, theme] }),
    manifest({ themes: [{ ...theme, colors: { ...theme.colors, accent: '#123456; display:none' } }] }),
    manifest({ themes: [{ ...theme, colors: { ...theme.colors, extra: '#abcdef' } }] }),
  ]) await assert.rejects(inspect(archive(data)), { code: 'INVALID_MANIFEST' });
});

test('engine range v1 applies numeric ordering, inclusive minimum and exclusive maximum', async t => {
  const { inspect } = await fixture(t);
  const withRange = cevra => archive({ ...manifest(), engines: { cevra } });
  assert.equal((await inspect(withRange('>=' + engineVersion + ' <0.10.0'))).engineVersion, engineVersion);
  await assert.rejects(inspect(withRange('>=0.0.0 <' + engineVersion)), { code: 'INCOMPATIBLE_ENGINE' });
  await assert.rejects(inspect(withRange('>=0.10.0 <1.0.0')), { code: 'INCOMPATIBLE_ENGINE' });
  await assert.rejects(inspect(withRange('>=999999999.999999999.999999998 <999999999.999999999.999999999')),
    { code: 'INCOMPATIBLE_ENGINE' });
  for (const range of ['^0.1.0', '>=0.1.0 <0.1.0', '>=0.1.0  <1.0.0', '>=0.1.0 <1.0.0-beta', '>=0.1.0 <1.0.0\n']) {
    await assert.rejects(inspect(withRange(range)), { code: 'INVALID_MANIFEST' });
  }
});

test('selected packages must be local regular files without hardlinks or directory links', async t => {
  const { root, folder, file } = await fixture(t);
  await fs.writeFile(file, archive());
  await assert.rejects(inspectExtensionPackage(folder), { code: 'INVALID_PACKAGE_PATH' });
  await assert.rejects(inspectExtensionPackage(path.join(root, 'missing.zip')), { code: 'PACKAGE_READ_FAILED' });
  await assert.rejects(inspectExtensionPackage(file + '\0'), { code: 'INVALID_PACKAGE_PATH' });
  const link = path.join(root, 'aliased packages');
  await fs.symlink(folder, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectExtensionPackage(path.join(link, path.basename(file))), { code: 'INVALID_PACKAGE_PATH' });
  if (process.platform === 'win32') {
    await assert.rejects(inspectExtensionPackage(file + ':alternate'), { code: 'INVALID_PACKAGE_PATH' });
    await assert.rejects(inspectExtensionPackage(path.join(folder, 'NUL.zip')), { code: 'INVALID_PACKAGE_PATH' });
    await assert.rejects(inspectExtensionPackage('C:relative.zip'), { code: 'INVALID_PACKAGE_PATH' });
  }
  const hardlink = path.join(root, 'hardlink.zip');
  await fs.link(file, hardlink);
  await assert.rejects(inspectExtensionPackage(hardlink), { code: 'INVALID_PACKAGE_PATH' });
  await assert.rejects(inspectExtensionPackage(file), { code: 'INVALID_PACKAGE_PATH' });
});

test('inspection rejects a selected package replaced between checking and opening it', async t => {
  const { file } = await fixture(t);
  const first = archive();
  const next = archive({ ...manifest(), version: '2.0.0' });
  await fs.writeFile(file, first);
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    await fs.rename(file, file + '.previous');
    await fs.writeFile(file, next);
    return open(...args);
  });
  await assert.rejects(inspectExtensionPackage(file), { code: 'PACKAGE_CHANGED' });
  assert.deepEqual(await fs.readFile(file + '.previous'), first);
  assert.deepEqual(await fs.readFile(file), next);
});
