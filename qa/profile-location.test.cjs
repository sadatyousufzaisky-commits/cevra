const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { appId, productName } = require('../src/identity.cjs');
const { profileLocation } = require('../src/profile-location.cjs');
const { temporaryFolder } = require('./temp.cjs');

test('profile selection preserves legacy data and treats independent profiles as separate', async t => {
  const appData = await temporaryFolder(t, 'vokri-profile-selection-');
  const current = path.join(appData, 'VOKRI Code');
  const legacy = path.join(appData, 'CEVRA');
  assert.deepEqual(profileLocation(appData), { directory: current, state: 'current' });
  assert.deepEqual(await fs.readdir(appData), []);
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'marker'), 'legacy');
  assert.deepEqual(profileLocation(appData), { directory: legacy, state: 'retained' });
  await fs.mkdir(current);
  await fs.writeFile(path.join(current, 'marker'), 'current');
  assert.deepEqual(profileLocation(appData), { directory: current, state: 'separate' });
  assert.deepEqual(profileLocation(appData, legacy), { directory: legacy, state: 'custom' });
  assert.equal(await fs.readFile(path.join(legacy, 'marker'), 'utf8'), 'legacy');
  assert.equal(await fs.readFile(path.join(current, 'marker'), 'utf8'), 'current');
  await fs.writeFile(path.join(appData, 'other'), 'file');
  assert.deepEqual(profileLocation(path.join(appData, 'other'), legacy), { directory: legacy, state: 'custom' });
});

test('an occupied default path fails without modifying either profile', async t => {
  const appData = await temporaryFolder(t, 'vokri-occupied-profile-');
  const current = path.join(appData, 'VOKRI Code');
  await fs.writeFile(current, 'occupied');
  assert.throws(() => profileLocation(appData), /occupied by a file/);
  assert.deepEqual(await fs.readdir(appData), ['VOKRI Code']);
  assert.equal(await fs.readFile(current, 'utf8'), 'occupied');
});

test('the public identity and Windows icon directory match the brand contract', async () => {
  const root = path.resolve(__dirname, '..');
  const contract = require('../docs/phase-6/brand-identity.json');
  const metadata = require('../package.json');
  assert.equal(metadata.name, contract.packageName);
  assert.equal(metadata.productName, productName);
  assert.equal(contract.appUserModelId, appId);
  const icon = await fs.readFile(path.join(root, 'assets', 'brand', 'vc.ico'));
  const png = await fs.readFile(path.join(root, 'assets', 'brand', 'vc.png'));
  assert.equal(createHash('sha256').update(icon).digest('hex'), contract.assets.windowsIconSha256);
  assert.equal(createHash('sha256').update(png).digest('hex'), contract.assets.pngSha256);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), contract.assets.windowsSizes.length);
  for (const [index, size] of contract.assets.windowsSizes.entries()) {
    const entry = 6 + 16 * index;
    const start = icon.readUInt32LE(entry + 12);
    assert.equal(icon[entry] || 256, size);
    assert.equal(icon[entry + 1] || 256, size);
    assert.equal(icon.readUInt32BE(start + 16), size);
    assert.equal(icon.readUInt32BE(start + 20), size);
    assert.equal(icon[start + 25], 6, 'The PNG frame must preserve alpha.');
  }
});

test('current UI keeps the old name only in allowlisted compatibility strings', async () => {
  const source = path.resolve(__dirname, '../src');
  const compatibility = /\bcevra(?:\/Intelligence\/v1\/|[-._:]|\/source)|['"](?:\/)?cevra['"]|(?:window|engines)\.cevra\b|\.cevra\/ai-instructions\.md/gi;
  const entries = await fs.readdir(source, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:cjs|js|html|css|cs)$/.test(entry.name)) continue;
    const filename = path.join(entry.parentPath, entry.name);
    const text = await fs.readFile(filename, 'utf8');
    if (entry.name === 'profile-location.cjs') continue;
    assert.ok(!/\bCEVRA\b/i.test(text.replace(compatibility, '')), path.relative(source, filename));
  }
});
