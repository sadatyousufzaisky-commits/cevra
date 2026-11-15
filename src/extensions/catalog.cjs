const path = require('node:path');
const { digestPattern, exactKeys, safeText } = require('./capabilities.cjs');
const { inspectExtensionPackage, readCheckedFile } = require('./inspect-package.cjs');
const { checkKeys, packageId, versionPattern } = require('./manifest.cjs');

const source = 'Bundled local catalog';
const publisher = 'VOKRI Code project';
const categories = new Set(['Editing', 'Commands']);
const maxCatalogBytes = 32 * 1024;
const maxReleases = 32;

function decodeCatalog(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const data = JSON.parse(text);
  checkKeys(text);
  return data;
}

function validateReleases(releases, online = false) {
  if (!Array.isArray(releases) || releases.length > maxReleases) throw new Error('Invalid catalog releases.');
  const fields = ['id', 'version', 'displayName', 'description', 'category', 'executable', 'sha256'];
  if (online) fields.push('engine', 'permissionCount');
  const ids = new Set();
  for (const release of releases) {
    if (!exactKeys(release, fields) ||
        !safeText(release.id, 100) || !packageId.test(release.id) || ids.has(release.id) ||
        typeof release.version !== 'string' || !versionPattern.test(release.version) ||
        !safeText(release.displayName, 80) || !safeText(release.description, 320) ||
        !categories.has(release.category) || typeof release.executable !== 'boolean' ||
        typeof release.sha256 !== 'string' || !digestPattern.test(release.sha256) ||
        (online && (!safeText(release.engine, 62) || !Number.isSafeInteger(release.permissionCount) ||
          (release.executable ? release.permissionCount < 1 || release.permissionCount > 5 : release.permissionCount !== 0)))) {
      throw new Error('Invalid catalog entry.');
    }
    ids.add(release.id);
  }
  return releases;
}

function verifyRelease(release, report) {
  const { manifest } = report;
  if (report.sha256 !== release.sha256 || manifest.id !== release.id || manifest.version !== release.version ||
      manifest.displayName !== release.displayName || manifest.description !== release.description ||
      (manifest.schemaVersion === 2) !== release.executable ||
      (release.engine && (release.engine !== manifest.engines.cevra || release.permissionCount !== manifest.permissions.length))) {
    throw new Error('The package does not match its catalog digest or metadata.');
  }
}

function createExtensionCatalog({ root = path.resolve(__dirname, '..', '..', 'assets', 'extension-store'), hostSupported }) {
  async function entries() {
    const index = decodeCatalog(await readCheckedFile(path.join(root, 'catalog.json'), maxCatalogBytes));
    if (!exactKeys(index, ['schemaVersion', 'releases']) || index.schemaVersion !== 1) throw new Error('Invalid local catalog.');
    return validateReleases(index.releases);
  }

  async function packageFor(release) {
    const file = path.join(root, release.id + '-' + release.version + '.zip');
    let report;
    try { report = await inspectExtensionPackage(file); }
    catch (error) {
      if (error.code === 'INCOMPATIBLE_ENGINE') throw error;
      throw new Error('The bundled ZIP could not be opened or inspected.');
    }
    verifyRelease(release, report);
    return { file, report, source, publisher };
  }

  return {
    async list() {
      const releases = await entries().catch(() => null);
      if (!releases) return { source, hostSupported, entries: [], error: 'The bundled catalog is unavailable.' };
      const available = await Promise.all(releases.map(async release => {
        try {
          const { report } = await packageFor(release);
          return { ...release, publisher, engine: report.manifest.engines.cevra,
            permissionCount: report.manifest.permissions.length };
        } catch (error) {
          return { ...release, publisher, unavailable: error.message };
        }
      }));
      return { source, hostSupported, entries: available };
    },
    async select(id, digest) {
      const releases = await entries().catch(() => []);
      const release = releases.find(entry => entry.id === id && entry.sha256 === digest);
      if (!release) throw new Error('The catalog entry changed or is unavailable. Refresh the catalog.');
      return packageFor(release);
    },
  };
}

module.exports = { createExtensionCatalog, decodeCatalog, publisher, validateReleases, verifyRelease };
