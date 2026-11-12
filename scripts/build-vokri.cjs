const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Building Vokri requires Windows x64.');
const sdkOnly = process.argv[2] === '--sdk-only';
if (process.argv.length > (sdkOnly ? 3 : 2)) throw new Error('Usage: node scripts/build-vokri.cjs [--sdk-only]');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'vokri', 'src');
const host = path.join(root, 'vokri', 'hosts', 'cevra');
const output = path.join(root, 'dist', 'vokri');
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const sdk = path.join(output, 'Vokri.dll');
const common = ['/nologo', '/platform:x64', '/optimize+', '/warnaserror+'];

function compile(args) { execFileSync(compiler, [...common, ...args], { stdio: 'inherit', windowsHide: true }); }
const csFiles = folder => fs.readdirSync(folder).filter(name => name.endsWith('.cs')).sort().map(name => path.join(folder, name));
fs.mkdirSync(output, { recursive: true });
compile(['/target:library', '/out:' + sdk, '/reference:System.Web.Extensions.dll', ...csFiles(source)]);
if (!sdkOnly) {
  compile(['/target:winexe', '/out:' + path.join(output, 'Vokri.Cevra.exe'), '/reference:' + sdk,
    '/win32manifest:' + path.join(host, 'vokri.manifest'), ...csFiles(host)]);
}
console.log(sdkOnly ? 'Built Vokri.dll' : 'Built Vokri.dll and Vokri.Cevra.exe');
