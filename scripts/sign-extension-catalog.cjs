const fs = require('node:fs');
const path = require('node:path');
const { createPrivateKey, createPublicKey, sign } = require('node:crypto');
const { signingKey } = require('../src/extensions/online-catalog.cjs');
const { verifyRelease, validateReleases } = require('../src/extensions/catalog.cjs');
const { describePackage } = require('../src/extensions/inspect-package.cjs');

const [directory, sequence, days] = process.argv.slice(2);
const generation = Number(sequence);
const lifetime = Number(days);
if (!directory || !Number.isSafeInteger(generation) || generation < 1 ||
    !Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 365) {
  throw new Error('Supply an output directory, a catalog generation, and a lifetime of 1 to 365 days.');
}
const privateKey = createPrivateKey({
  key: Buffer.from(fs.readFileSync(0, 'utf8').trim(), 'base64'), type: 'pkcs8', format: 'der',
});
if (createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64') !== signingKey) {
  throw new Error('The private key does not match the public key pinned in VOKRI Code.');
}

const bundled = path.resolve(__dirname, '..', 'assets', 'extension-store');
const { releases } = require(path.join(bundled, 'catalog.json'));
const packages = validateReleases(releases).map(entry => {
  const bytes = fs.readFileSync(path.join(bundled, entry.id + '-' + entry.version + '.zip'));
  const report = describePackage(bytes);
  verifyRelease(entry, report);
  return { bytes, entry: { ...entry, engine: report.manifest.engines.cevra, permissionCount: report.manifest.permissions.length } };
});
const published = path.join(directory, 'packages');
fs.mkdirSync(published, { recursive: true });
for (const { bytes, entry } of packages) {
  const filename = path.join(published, entry.sha256 + '.zip');
  if (fs.existsSync(filename)) {
    if (!fs.readFileSync(filename).equals(bytes)) throw new Error('A published package changed.');
  } else fs.writeFileSync(filename, bytes, { flag: 'wx' });
}

const payload = Buffer.from(JSON.stringify({
  schemaVersion: 1, generation, expiresAt: Date.now() + lifetime * 86_400_000, releases: packages.map(({ entry }) => entry),
}));
const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify(envelope, null, 2) + '\n');
console.log('Signed online catalog generation ' + generation + ' with ' + packages.length + ' packages.');
