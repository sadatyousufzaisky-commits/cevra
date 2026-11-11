const { InspectionError } = require('../src/extensions/inspection-error.cjs');
const { readCheckedFile, selectedPath } = require('../src/extensions/inspect-package.cjs');
const { maxManifestBytes } = require('../src/extensions/package-zip.cjs');
const { validateManifest } = require('../sdk/extensions/manifest.cjs');

async function validate(filename) {
  const bytes = await readCheckedFile(selectedPath(filename), maxManifestBytes);
  console.log(JSON.stringify(validateManifest(bytes), null, 2));
}

const [filename, ...extra] = process.argv.slice(2);
if (!filename || extra.length) {
  console.error('Usage: npm run validate:extension -- <extension.json>');
  process.exitCode = 2;
} else {
  validate(filename).catch(error => {
    console.error(error instanceof InspectionError ? error.code + ' ' + error.message :
      'MANIFEST_READ_FAILED The selected manifest could not be read.');
    process.exitCode = 1;
  });
}
