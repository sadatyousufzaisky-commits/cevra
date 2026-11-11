const fs = require('node:fs/promises');
const path = require('node:path');
const { version } = require('../package.json');
const { parseManifest } = require('../src/extensions/manifest.cjs');
const { describePackage, readCheckedFile, selectedPath } = require('../src/extensions/inspect-package.cjs');
const { InspectionError } = require('../src/extensions/inspection-error.cjs');
const { manifestPath, modulePath, maxManifestBytes, packExtensionZip } = require('../src/extensions/package-zip.cjs');

async function pack(source, target) {
  const folder = selectedPath(source);
  const output = selectedPath(target);
  const manifestBytes = await readCheckedFile(path.join(folder, manifestPath), maxManifestBytes);
  const manifest = parseManifest(manifestBytes, version);
  const moduleBytes = manifest.schemaVersion === 2 ? await readCheckedFile(path.join(folder, modulePath), maxManifestBytes) : undefined;
  const archive = packExtensionZip(manifestBytes, moduleBytes);
  const report = describePackage(archive);
  await fs.writeFile(output, archive, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}

const [source, output, ...extra] = process.argv.slice(2);
if (!source || !output || extra.length) {
  console.error('Usage: npm run pack:extension -- <source-folder> <output.zip>');
  process.exitCode = 2;
} else {
  pack(source, output).catch(error => {
    const message = error instanceof InspectionError ? error.code + ' ' + error.message :
      error.code === 'EEXIST' ? 'OUTPUT_EXISTS Choose a new ZIP filename.' :
        error.code === 'ENOENT' ? 'PACKAGE_PATH Check the source files and the output folder.' :
          'PACK_FAILED CEVRA could not create the ZIP package.';
    console.error(message);
    process.exitCode = 1;
  });
}
