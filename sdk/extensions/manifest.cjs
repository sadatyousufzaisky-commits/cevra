const { version } = require('../../package.json');
const { InspectionError } = require('../../src/extensions/inspection-error.cjs');
const { parseManifest } = require('../../src/extensions/manifest.cjs');
const { maxManifestBytes } = require('../../src/extensions/package-zip.cjs');

function validateManifest(bytes) {
  if (bytes.byteLength > maxManifestBytes) {
    throw new InspectionError('PACKAGE_TOO_LARGE', 'The manifest exceeds 128 KiB.');
  }
  return parseManifest(bytes, version);
}

module.exports = { validateManifest };
