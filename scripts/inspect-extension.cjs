const { inspectExtensionPackage } = require('../src/extensions/inspect-package.cjs');
const { InspectionError } = require('../src/extensions/inspection-error.cjs');

const [filename, ...extra] = process.argv.slice(2);
if (!filename || extra.length) {
  console.error('Usage: npm run inspect:extension -- <local-package.zip>');
  process.exitCode = 2;
} else {
  inspectExtensionPackage(filename).then(report => {
    console.log(JSON.stringify(report, null, 2));
  }).catch(error => {
    console.error(error instanceof InspectionError ? error.code + ' ' + error.message : 'INSPECTION_FAILED Package inspection failed.');
    process.exitCode = 1;
  });
}
