const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Building Vokri requires Windows x64.');
const target = process.argv[2] ?? '--all';
if (process.argv.length > 3 || !['--all', '--sdk-only', '--sample', '--product'].includes(target)) {
  throw new Error('Usage: node scripts/build-vokri.cjs [--sdk-only | --sample | --product]');
}
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'vokri', 'src');
const host = path.join(root, 'vokri', 'hosts', 'cevra');
const sample = path.join(root, 'vokri', 'samples', 'workbench');
const output = path.join(root, 'dist', 'vokri');
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const sdk = path.join(output, 'Vokri.dll');
const common = ['/nologo', '/platform:x64', '/optimize+', '/warnaserror+'];

function compile(args) { execFileSync(compiler, [...common, ...args], { stdio: 'inherit', windowsHide: true }); }
const csFiles = folder => fs.readdirSync(folder).filter(name => name.endsWith('.cs')).sort().map(name => path.join(folder, name));
fs.mkdirSync(output, { recursive: true });
compile(['/target:library', '/out:' + sdk, '/reference:System.Web.Extensions.dll', ...csFiles(source)]);
if (target === '--all') {
  compile(['/target:winexe', '/out:' + path.join(output, 'Vokri.Cevra.exe'), '/reference:' + sdk,
    '/win32manifest:' + path.join(host, 'vokri.manifest'), ...csFiles(host)]);
}
if (target === '--product') {
  compile(['/target:winexe', '/define:VOKRI_PRODUCT', '/out:' + path.join(output, 'VokriCode.exe'), '/reference:' + sdk,
    '/win32manifest:' + path.join(host, 'product.manifest'), '/win32icon:' + path.join(root, 'assets', 'brand', 'vc.ico'),
    ...csFiles(host)]);
}
if (target === '--sample' || target === '--all') {
  compile(['/target:winexe', '/out:' + path.join(output, 'Vokri.Sample.exe'), '/reference:' + sdk,
    '/win32manifest:' + path.join(sample, 'app.manifest'), '/win32icon:' + path.join(root, 'assets', 'brand', 'vc.ico'),
    ...csFiles(sample)]);
}
const programs = { '--all': ', Vokri.Cevra.exe and Vokri.Sample.exe', '--sample': ' and Vokri.Sample.exe',
  '--product': ' and VokriCode.exe' };
console.log('Built Vokri.dll' + (programs[target] ?? ''));
