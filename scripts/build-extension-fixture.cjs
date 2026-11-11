const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const zig = path.join(root, 'dist', 'g3-runtime', 'zig-x86_64-windows-0.15.2', 'zig.exe');
execFileSync(zig, ['cc', '-target', 'wasm32-freestanding', '-O2', '-g0', '-nostdlib', '-Wl,--strip-all',
  '-Wl,--no-entry', '-Wl,--export-memory', '-Wl,-z,stack-size=65536', '-Wl,--initial-memory=262144', '-Wl,--max-memory=1048576',
  path.join(root, 'qa', 'extension-runtime-fixture.c'),
  '-o', path.join(root, 'dist', 'extension-host-lab', 'broker-fixture.wasm')], { stdio: 'inherit', windowsHide: true });
