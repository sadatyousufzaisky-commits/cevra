const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const zig = path.join(root, 'dist', 'g3-runtime', 'zig-x86_64-windows-0.15.2', 'zig.exe');

function compileExtension(source, output, includes = []) {
  execFileSync(zig, [
    'cc', '-target', 'wasm32-freestanding', '-O2', '-g0', '-nostdlib', '-Wl,--strip-all',
    '-Wl,--no-entry', '-Wl,--export-memory', '-Wl,-z,stack-size=65536',
    '-Wl,--initial-memory=262144', '-Wl,--max-memory=1048576',
    ...includes.map(include => '-I' + include), source, '-o', output,
  ], { stdio: 'inherit', windowsHide: true });
}

module.exports = { compileExtension };
