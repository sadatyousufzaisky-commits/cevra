const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('The extension isolation lab requires Windows x64.');
}
const root = path.resolve(__dirname, '..');
const cache = path.join(root, 'dist', 'g3-runtime');
const output = path.join(root, 'dist', 'extension-host-lab');
const source = path.join(root, 'src', 'extensions', 'host-lab');
const run = (program, args, cwd = root) => execFileSync(program, args, { cwd, stdio: 'inherit', windowsHide: true });
fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(output, { recursive: true });

function verifiedArchive(filename, url, digest, fallback) {
  const archive = path.join(cache, filename);
  if (!fs.existsSync(archive)) {
    const temporary = archive + '.download';
    const download = ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '250', '--output', temporary];
    try {
      try { run('curl.exe', [...download, url]); }
      catch (error) {
        if (!fallback) throw error;
        run('curl.exe', [...download, '--header', 'Accept: application/octet-stream', fallback]);
      }
      if (hash(temporary) !== digest) throw new Error('Downloaded archive digest mismatch for ' + filename);
      fs.renameSync(temporary, archive);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  if (hash(archive) !== digest) throw new Error('Cached archive digest mismatch for ' + filename);
  return archive;
}

function hash(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

const zigFolder = 'zig-x86_64-windows-0.15.2';
const zigArchive = verifiedArchive('zig-0.15.2.zip', 'https://ziglang.org/download/0.15.2/' + zigFolder + '.zip',
  '3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c');
const runtimeFolder = 'wasmtime-v36.0.20-x86_64-windows-c-api';
const runtimeArchive = verifiedArchive('wasmtime-v36.0.20.zip',
  'https://github.com/bytecodealliance/wasmtime/releases/download/v36.0.20/' + runtimeFolder + '.zip',
  '857d032cef5fb06673a13e9510028e5e6b6adf9c2ac20cf2ff39768d2c3a882c',
  'https://api.github.com/repos/bytecodealliance/wasmtime/releases/assets/689393125');
const zig = path.join(cache, zigFolder, 'zig.exe');
if (!fs.existsSync(zig)) run('tar.exe', ['-xf', zigArchive, '-C', cache]);
const runtime = path.join(cache, runtimeFolder);
if (!fs.existsSync(path.join(runtime, 'lib', 'wasmtime.dll'))) {
  run('tar.exe', ['-xf', runtimeArchive, '-C', cache, runtimeFolder + '/include', runtimeFolder + '/lib/wasmtime.dll',
    runtimeFolder + '/lib/wasmtime.dll.lib', runtimeFolder + '/LICENSE']);
}
const runtimeLibrary = path.join(runtime, 'lib', 'wasmtime.dll');
if (hash(zig) !== 'd408dd38eed3e5204af841bcebf70502a4dbbb8399a3a3262be55059370bc018' ||
    hash(runtimeLibrary) !== '08bfbfa7a866f7996e841c6603df3809cfc8dc6ace48c646fc2c9e0b56ef757d') {
  throw new Error('The extracted isolation-lab compiler or runtime failed digest verification.');
}
const flags = ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-Wall', '-Wextra', '-Werror'];
run(zig, [...flags, '-I' + path.join(runtime, 'include'), path.join(source, 'worker.c'),
  path.join(runtime, 'lib', 'wasmtime.dll.lib'), '-o', path.join(output, 'extension-worker.exe')]);
run(zig, [...flags, path.join(root, 'qa', 'extension-host-probe.c'),
  '-lws2_32', '-o', path.join(output, 'extension-probe.exe')]);
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
run(compiler, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', '/main:ExtensionLabLauncher',
  '/out:' + path.join(output, 'extension-launcher.exe'), path.join(source, 'launcher.cs'),
  path.join(root, 'src', 'execution', 'windows-host.cs'), path.join(root, 'src', 'execution', 'windows-terminal.cs')]);
fs.copyFileSync(runtimeLibrary, path.join(output, 'wasmtime.dll'));
fs.copyFileSync(path.join(runtime, 'LICENSE'), path.join(output, 'WASMTIME-LICENSE'));
