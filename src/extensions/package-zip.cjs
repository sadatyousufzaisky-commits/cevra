const { crc32, inflateRawSync } = require('node:zlib');
const { InspectionError } = require('./inspection-error.cjs');

const manifestPath = 'extension.json';
const manifestName = Buffer.from(manifestPath, 'ascii');
const maxPackageBytes = 256 * 1024;
const maxManifestBytes = 128 * 1024;
const localHeaderBytes = 30;
const directoryHeaderBytes = 46;
const endRecordBytes = 22;
const dataStart = localHeaderBytes + manifestName.length;
const directoryBytes = directoryHeaderBytes + manifestName.length;
const dosFileFlags = 0x00a7;

function reject(message) {
  throw new InspectionError('INVALID_ARCHIVE', message);
}

function unpackManifest(archive) {
  const end = archive.length - endRecordBytes;
  if (end <= dataStart + directoryBytes || archive.readUInt32LE(end) !== 0x06054b50) {
    reject('Choose a v1 ZIP with one root extension.json and no archive comment.');
  }
  const directory = archive.readUInt32LE(end + 16);
  if (archive.readUInt32LE(end + 4) !== 0 || archive.readUInt16LE(end + 8) !== 1 ||
      archive.readUInt16LE(end + 10) !== 1 || archive.readUInt32LE(end + 12) !== directoryBytes ||
      archive.readUInt16LE(end + 20) !== 0 || directory <= dataStart || directory + directoryBytes !== end) {
    reject('The ZIP must contain one regular extension.json entry on a single disk.');
  }
  if (archive.readUInt32LE(directory) !== 0x02014b50 || archive.readUInt32LE(0) !== 0x04034b50 ||
      archive.readUInt32LE(directory + 42) !== 0 || archive.readUInt16LE(26) !== manifestName.length ||
      archive.readUInt16LE(directory + 28) !== manifestName.length || archive.readUInt16LE(28) !== 0 ||
      archive.readUInt32LE(directory + 30) !== 0 || archive.readUInt16LE(directory + 34) !== 0 ||
      !archive.subarray(localHeaderBytes, dataStart).equals(manifestName) ||
      !archive.subarray(directory + directoryHeaderBytes, end).equals(manifestName)) {
    reject('The ZIP entry must be named exactly extension.json and use the v1 layout.');
  }
  if (!archive.subarray(4, 26).equals(archive.subarray(directory + 6, directory + 28))) {
    reject('The ZIP headers disagree.');
  }

  const platform = archive[directory + 5];
  const attributes = archive.readUInt32LE(directory + 38);
  const fileType = (attributes >>> 16) & 0xf000;
  const flags = archive.readUInt16LE(6);
  const method = archive.readUInt16LE(8);
  const requiredVersion = archive.readUInt16LE(4);
  // Accept ordinary DOS file flags and absent or regular Unix file types.
  if (![0, 3, 10, 19].includes(platform) || ((attributes & 0xffff) & ~dosFileFlags) || ![0, 0x8000].includes(fileType)) {
    reject('The ZIP entry must be a regular file.');
  }
  if (![0, 0x0800].includes(flags) || ![0, 8].includes(method) ||
      ![10, 20].includes(requiredVersion) || (method === 8 && requiredVersion !== 20)) {
    reject('The ZIP uses an unsupported feature. Use stored or DEFLATE compression without encryption or data descriptors.');
  }
  const compressedBytes = archive.readUInt32LE(18);
  const manifestBytes = archive.readUInt32LE(22);
  if (manifestBytes > maxManifestBytes) {
    throw new InspectionError('MANIFEST_TOO_LARGE', 'The manifest exceeds 128 KiB.');
  }
  if (manifestBytes === 0 || compressedBytes !== directory - dataStart || (method === 0 && compressedBytes !== manifestBytes)) {
    reject('The ZIP has inconsistent manifest sizes.');
  }

  const payload = archive.subarray(dataStart, directory);
  let manifest = payload;
  if (method === 8) {
    let inflated;
    try { inflated = inflateRawSync(payload, { maxOutputLength: manifestBytes, info: true }); }
    catch { reject('The compressed manifest is invalid or exceeds its declared size.'); }
    manifest = inflated.buffer;
    if (inflated.engine.bytesWritten !== compressedBytes) reject('The compressed manifest has trailing data.');
  }
  if (manifest.length !== manifestBytes || crc32(manifest) !== archive.readUInt32LE(14)) {
    reject('The manifest failed its size or CRC32 check.');
  }
  return manifest;
}

module.exports = { manifestPath, maxPackageBytes, unpackManifest };
