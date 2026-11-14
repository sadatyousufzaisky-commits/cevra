const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform === 'win32' && process.arch === 'x64') {
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'src', 'intelligence', 'windows-vault.cs');
  const metadata = path.join(root, 'src', 'windows-product.cs');
  const icon = path.join(root, 'assets', 'brand', 'vc.ico');
  const target = path.join(root, 'dist', 'vokri-credential-vault.exe');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const installed = fs.statSync(target, { throwIfNoEntry: false });
  if (!installed || [source, metadata, icon, __filename].some(file => fs.statSync(file).mtimeMs >= installed.mtimeMs)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFileSync(compiler, [
      '/nologo', '/optimize+', '/warnaserror+', '/platform:x64', '/target:winexe',
      '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/win32icon:' + icon, '/out:' + target, source, metadata,
    ], { stdio: 'inherit', windowsHide: true });
  }
}
