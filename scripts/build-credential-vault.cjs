const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform === 'win32' && process.arch === 'x64') {
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'src', 'intelligence', 'windows-vault.cs');
  const target = path.join(root, 'dist', 'cevra-credential-vault.exe');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const installed = fs.statSync(target, { throwIfNoEntry: false });
  if (!installed || [source, __filename].some(file => fs.statSync(file).mtimeMs >= installed.mtimeMs)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFileSync(compiler, [
      '/nologo', '/optimize+', '/warnaserror+', '/platform:x64', '/target:winexe',
      '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/out:' + target, source,
    ], { stdio: 'inherit', windowsHide: true });
  }
}
