const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform === 'win32') {
  const root = path.resolve(__dirname, '..');
  const sources = ['windows-host.cs', 'windows-terminal.cs'].map(name => path.join(root, 'src', 'execution', name));
  const target = path.join(root, 'dist', 'cevra-process-host.exe');
  const installed = fs.statSync(target, { throwIfNoEntry: false });
  if (!installed || sources.some(source => fs.statSync(source).mtimeMs >= installed.mtimeMs)) {
    const frameworks = ['Framework64', 'Framework'];
    const compiler = frameworks.map(name => path.join(process.env.SystemRoot || 'C:\\Windows',
      'Microsoft.NET', name, 'v4.0.30319', 'csc.exe')).find(file => fs.existsSync(file));
    if (!compiler) throw new Error('The Windows .NET Framework 4.x compiler is required to build CEVRA’s process host.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/out:' + target, ...sources], {
      stdio: 'inherit', windowsHide: true,
    });
  }
}
