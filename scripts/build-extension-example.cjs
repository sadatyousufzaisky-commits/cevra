const fs = require('node:fs');
const path = require('node:path');
const { compileExtension } = require('./compile-extension-wasm.cjs');
const { validateManifest } = require('../sdk/extensions/manifest.cjs');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'examples', 'extensions', 'hello-command');
const output = path.join(root, 'dist', 'extension-examples', 'hello-command');
const manifest = fs.readFileSync(path.join(source, 'extension.json'));

validateManifest(manifest);
fs.mkdirSync(output, { recursive: true });
compileExtension(path.join(source, 'command.c'), path.join(output, 'extension.wasm'),
  [path.join(root, 'sdk', 'extensions')]);
fs.writeFileSync(path.join(output, 'extension.json'), manifest);
console.log('Built extension example at ' + output);
