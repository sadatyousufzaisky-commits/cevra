const fs = require('node:fs/promises');
const path = require('node:path');
const { writeAtomic } = require('../atomic-file.cjs');
const { describePackage, loadExtensionPackage, readCheckedFile, sha256 } = require('./inspect-package.cjs');
const { maxPackageBytes } = require('./package-zip.cjs');
const { packageId, versionPattern } = require('./manifest.cjs');
const { InspectionError } = require('./inspection-error.cjs');

const maxEntries = 64;
const maxArchiveBytes = 16 * 1024 * 1024;
const maxSnapshotBytes = Math.ceil(maxArchiveBytes / 3) * 4 + 128 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;
const temporaryPattern = /^\.cevra-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/;
const writers = new Map();
const listeners = new Map();

function fail(code, message) {
  throw new InspectionError(code, message);
}

function corrupt() {
  fail('REGISTRY_CORRUPT', 'The extension registry is unreadable or damaged.');
}

function keys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const validId = value => typeof value === 'string' && value.length >= 3 && value.length <= 100 && packageId.test(value);
const encode = value => Buffer.from(JSON.stringify(value));

function validateSnapshot(data) {
  if (!keys(data, ['version', 'entries', 'archives']) || data.version !== 1 ||
      !Array.isArray(data.entries) || data.entries.length > maxEntries ||
      !data.archives || typeof data.archives !== 'object' || Array.isArray(data.archives)) corrupt();
  const referenced = new Set();
  let lastId = '';
  for (const entry of data.entries) {
    if (!keys(entry, ['id', 'enabled', 'current', 'previous']) || !validId(entry.id) ||
        entry.id <= lastId || typeof entry.enabled !== 'boolean') corrupt();
    lastId = entry.id;
    const versions = entry.previous === null ? [entry.current] : [entry.current, entry.previous];
    for (const version of versions) {
      if (!keys(version, ['sha256', 'version', 'quarantined']) || !matches(version.sha256, digestPattern) ||
          !matches(version.version, versionPattern) || typeof version.quarantined !== 'boolean' ||
          referenced.has(version.sha256) || !Object.hasOwn(data.archives, version.sha256)) corrupt();
      referenced.add(version.sha256);
    }
    if (entry.enabled && entry.current.quarantined) corrupt();
  }
  if (referenced.size !== Object.keys(data.archives).length) corrupt();
  let total = 0;
  for (const value of Object.values(data.archives)) {
    if (typeof value !== 'string' || value.length > Math.ceil(maxPackageBytes / 3) * 4) corrupt();
    const bytes = Buffer.from(value, 'base64');
    if (!bytes.length || bytes.length > maxPackageBytes || bytes.toString('base64') !== value) corrupt();
    total += bytes.length;
  }
  if (total > maxArchiveBytes) corrupt();
}

async function readSnapshot(file) {
  let bytes;
  try { bytes = await readCheckedFile(file, maxSnapshotBytes); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, entries: [], archives: {} };
    corrupt();
  }
  let snapshot;
  try { snapshot = JSON.parse(bytes); }
  catch { corrupt(); }
  if (!keys(snapshot, ['data', 'checksum']) || !matches(snapshot.checksum, digestPattern)) corrupt();
  validateSnapshot(snapshot.data);
  if (!encode(snapshot).equals(bytes) || sha256(encode(snapshot.data)) !== snapshot.checksum) corrupt();
  return snapshot.data;
}

async function checkedDirectory(folder) {
  const stat = await fs.lstat(folder, { bigint: true });
  if (!stat.isDirectory() || path.relative(folder, await fs.realpath(folder)) !== '') {
    fail('REGISTRY_PATH', 'The extension registry requires an app-data directory without links.');
  }
  return stat;
}

async function recover(folder) {
  for await (const item of await fs.opendir(folder)) {
    if (item.isFile() && temporaryPattern.test(item.name)) await fs.unlink(path.join(folder, item.name));
  }
}

function checkPackage(data, id, version) {
  const bytes = Buffer.from(data.archives[version.sha256], 'base64');
  if (sha256(bytes) !== version.sha256) fail('STORED_PACKAGE_CHANGED', 'The stored extension bytes do not match their digest.');
  const report = describePackage(bytes);
  if (report.manifest.id !== id || report.manifest.version !== version.version) {
    fail('STORED_PACKAGE_CHANGED', 'The stored extension does not match its registry record.');
  }
  return report.manifest;
}

function summary(data, entry) {
  const { id, current, previous } = entry;
  let state = current.quarantined ? 'quarantined' : entry.enabled ? 'enabled' : 'disabled';
  let failure;
  try { checkPackage(data, id, current); }
  catch (error) {
    if (!(error instanceof InspectionError)) throw error;
    state = 'failed';
    failure = error.code;
  }
  return {
    id, sha256: current.sha256, version: current.version, enabled: state === 'enabled', state,
    rollback: previous && { sha256: previous.sha256, version: previous.version },
    ...(failure && { failure }),
  };
}

function request(id, digest) {
  if (!validId(id) || !matches(digest, digestPattern)) {
    fail('INVALID_EXTENSION_REQUEST', 'Choose an installed extension and its current digest.');
  }
}

function findCurrent(data, id, digest, allowMissing = false) {
  const entry = data.entries.find(item => item.id === id);
  if ((!entry && !allowMissing) || (entry && entry.current.sha256 !== digest)) {
    fail('STALE_REGISTRY', 'The installed extension changed. Refresh and review it again.');
  }
  return entry;
}

function createExtensionRegistry(userData, { checkpoint = () => {} } = {}) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData)) {
    fail('REGISTRY_PATH', 'Use the absolute CEVRA app-data directory.');
  }
  const folder = path.join(userData, 'extensions');
  const file = path.join(folder, 'registry.json');
  const writerKey = process.platform === 'win32' ? folder.toLowerCase() : folder;

  function run(operation) {
    const next = (writers.get(writerKey) ?? Promise.resolve()).then(async () => {
      await checkedDirectory(path.dirname(folder));
      try { await fs.mkdir(folder, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const directory = await checkedDirectory(folder);
      const data = await readSnapshot(file);
      await recover(folder);
      return operation(data, async changedId => {
        const bytes = encode({ data, checksum: sha256(encode(data)) });
        if (bytes.length > maxSnapshotBytes) fail('REGISTRY_QUOTA', 'The extension registry reached its storage limit.');
        await checkpoint('prepared');
        await writeAtomic(file, bytes, {
          beforeCommit: async () => {
            await checkpoint('staged');
            const current = await checkedDirectory(folder);
            if (current.dev !== directory.dev || current.ino !== directory.ino || current.birthtimeNs !== directory.birthtimeNs) {
              fail('REGISTRY_PATH', 'The extension registry directory changed during the transaction.');
            }
          },
        });
        for (const listener of listeners.get(writerKey) ?? []) {
          try { listener(changedId); }
          catch (error) { process.emitWarning(error); }
        }
        await checkpoint('committed');
      });
    });
    const settled = next.catch(() => {});
    writers.set(writerKey, settled);
    void settled.then(() => { if (writers.get(writerKey) === settled) writers.delete(writerKey); });
    return next;
  }

  async function change(id, digest, mutate) {
    request(id, digest);
    return run(async (data, commit) => {
      const entry = findCurrent(data, id, digest);
      if (mutate(data, entry)) await commit(id);
      return summary(data, entry);
    });
  }

  return {
    list: () => run(data => data.entries.map(entry => summary(data, entry))),
    contributions: () => run(data => {
      const packages = [];
      for (const { id, current, enabled } of data.entries) {
        if (!enabled || current.quarantined) continue;
        let manifest;
        try { manifest = checkPackage(data, id, current); }
        catch (error) {
          if (!(error instanceof InspectionError)) throw error;
          continue;
        }
        const { sha256 } = current;
        const { snippets = [], themes = [] } = manifest.contributes;
        packages.push({ id, sha256, snippets, palettes: themes.map(theme => ({
          key: `${id}:${sha256}:${theme.id}`, label: theme.label, colors: theme.colors,
        })) });
      }
      return packages;
    }),
    onChange(listener) {
      const subscribers = listeners.get(writerKey) ?? new Set();
      subscribers.add(listener);
      listeners.set(writerKey, subscribers);
      return () => {
        subscribers.delete(listener);
        if (!subscribers.size && listeners.get(writerKey) === subscribers) listeners.delete(writerKey);
      };
    },
    async install(filename, { reviewedDigest, expectedCurrent = null } = {}) {
      if (!matches(reviewedDigest, digestPattern) || (expectedCurrent !== null && !matches(expectedCurrent, digestPattern))) {
        fail('INVALID_EXTENSION_REQUEST', 'Review the package digest and the current installed version first.');
      }
      const { archive, report } = await loadExtensionPackage(filename);
      if (report.sha256 !== reviewedDigest) fail('REVIEW_CHANGED', 'The package bytes changed after review.');
      const { id, version } = report.manifest;
      return run(async (data, commit) => {
        const existing = data.entries.find(entry => entry.id === id);
        if (existing?.current.sha256 === reviewedDigest) {
          checkPackage(data, id, existing.current);
          return summary(data, existing);
        }
        if ((existing?.current.sha256 ?? null) !== expectedCurrent) {
          fail('STALE_REGISTRY', 'The installed extension changed. Refresh and review it again.');
        }
        if (!existing && data.entries.length === maxEntries) fail('REGISTRY_QUOTA', 'The extension registry holds up to 64 extensions.');
        if (existing?.previous) delete data.archives[existing.previous.sha256];
        const entry = {
          id, enabled: false, current: { sha256: reviewedDigest, version, quarantined: false },
          previous: existing?.current ?? null,
        };
        if (existing?.previous?.sha256 === reviewedDigest) entry.current.quarantined = existing.previous.quarantined;
        data.archives[reviewedDigest] = archive.toString('base64');
        const total = Object.values(data.archives).reduce((sum, value) => sum + Buffer.from(value, 'base64').length, 0);
        if (total > maxArchiveBytes) fail('REGISTRY_QUOTA', 'Installed and rollback packages share a 16 MiB limit.');
        data.entries = data.entries.filter(item => item.id !== id).concat(entry).sort((a, b) => a.id < b.id ? -1 : 1);
        await commit(id);
        return summary(data, entry);
      });
    },
    async setEnabled(id, digest, enabled) {
      if (typeof enabled !== 'boolean') fail('INVALID_EXTENSION_REQUEST', 'Choose whether to enable the extension.');
      return change(id, digest, (data, entry) => {
        if (enabled) {
          if (entry.current.quarantined) fail('EXTENSION_QUARANTINED', 'The extension is quarantined.');
          checkPackage(data, id, entry.current);
        }
        if (entry.enabled === enabled) return false;
        entry.enabled = enabled;
        return true;
      });
    },
    quarantine: (id, digest) => change(id, digest, (_data, entry) => {
      if (entry.current.quarantined) return false;
      entry.enabled = false;
      entry.current.quarantined = true;
      return true;
    }),
    rollback: (id, digest) => change(id, digest, (data, entry) => {
      if (!entry.previous) fail('NO_ROLLBACK', 'There is no previous version to restore.');
      checkPackage(data, id, entry.previous);
      [entry.current, entry.previous] = [entry.previous, entry.current];
      entry.enabled = false;
      return true;
    }),
    async remove(id, digest) {
      request(id, digest);
      return run(async (data, commit) => {
        const entry = findCurrent(data, id, digest, true);
        if (!entry) return false;
        delete data.archives[entry.current.sha256];
        if (entry.previous) delete data.archives[entry.previous.sha256];
        data.entries = data.entries.filter(item => item !== entry);
        await commit(id);
        return true;
      });
    },
  };
}

module.exports = { createExtensionRegistry };
