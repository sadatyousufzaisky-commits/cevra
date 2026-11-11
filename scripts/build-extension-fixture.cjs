const path = require('node:path');
const { compileExtension } = require('./compile-extension-wasm.cjs');

const root = path.resolve(__dirname, '..');
compileExtension(
  path.join(root, 'qa', 'extension-runtime-fixture.c'),
  path.join(root, 'dist', 'extension-host-lab', 'broker-fixture.wasm'),
);
