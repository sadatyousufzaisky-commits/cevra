const { createHash } = require('node:crypto');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { version: engineVersion } = require('../../package.json');
const { InspectionError } = require('./inspection-error.cjs');
const { parseManifest } = require('./manifest.cjs');
const { manifestPath, maxPackageBytes, unpackManifest } = require('./package-zip.cjs');

const windows = process.platform === 'win32';
const reservedName = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i;
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function selectedPath(filename) {
  if (typeof filename !== 'string' || !filename.trim() || /[\x00-\x1f\x7f]/.test(filename)) {
    throw new InspectionError('INVALID_PACKAGE_PATH', 'Choose a local package file.');
  }
  const target = path.resolve(filename);
  if (windows && (!/^[a-z]:\\/i.test(target) || /^[a-z]:(?![\\/])/i.test(filename) ||
      target.slice(3).split('\\').some(part => /[:<>"|?*]|[. ]$/.test(part) || reservedName.test(part)))) {
    throw new InspectionError('INVALID_PACKAGE_PATH', 'Choose a regular package file on a local drive.');
  }
  return target;
}

async function checkedFile(file, limit) {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || path.relative(file, await fs.realpath(file)) !== '') {
    throw new InspectionError('INVALID_PACKAGE_PATH', 'Choose a regular package file without links.');
  }
  if (stat.size > BigInt(limit)) throw new InspectionError('PACKAGE_TOO_LARGE', 'The selected file exceeds its size limit.');
  return stat;
}

function sameFile(before, current) {
  return current.isFile() && current.nlink === 1n &&
    ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === current[key]);
}

function changedFile() {
  throw new InspectionError('PACKAGE_CHANGED', 'The package changed during inspection. Select it again.');
}

async function readCheckedFile(file, limit) {
  const before = await checkedFile(file, limit);
  const handle = await fs.open(file, readFlags);
  try {
    if (!sameFile(before, await handle.stat({ bigint: true }))) changedFile();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (BigInt(length) !== before.size || !sameFile(before, await handle.stat({ bigint: true })) ||
        !sameFile(before, await checkedFile(file, limit))) changedFile();
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function describePackage(archive) {
  if (archive.length > maxPackageBytes) throw new InspectionError('PACKAGE_TOO_LARGE', 'The ZIP exceeds 256 KiB.');
  const bytes = unpackManifest(archive);
  const manifest = parseManifest(bytes, engineVersion);
  return {
    format: 'cevra-zip-v1',
    engineVersion,
    sha256: sha256(archive),
    publisher: 'unverified',
    manifest,
    inventory: [{ path: manifestPath, bytes: bytes.length, sha256: sha256(bytes) }],
  };
}

async function loadExtensionPackage(filename) {
  const file = selectedPath(filename);
  const archive = await readCheckedFile(file, maxPackageBytes).catch(error => {
    if (error instanceof InspectionError) throw error;
    throw new InspectionError('PACKAGE_READ_FAILED', 'The selected package could not be read.');
  });
  return { archive, report: describePackage(archive) };
}

async function inspectExtensionPackage(filename) {
  return (await loadExtensionPackage(filename)).report;
}

module.exports = { describePackage, inspectExtensionPackage, loadExtensionPackage, readCheckedFile, sha256 };
