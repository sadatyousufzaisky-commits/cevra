const { execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const root = path.resolve(__dirname, '..');
const executable = path.join(root, 'dist', 'cevra-credential-vault-probe.exe');
const run = promisify(execFile);

function buildVaultProbe() {
  const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, [
    '/nologo', '/optimize+', '/warnaserror+', '/platform:x64', '/target:winexe', '/main:VaultProbe',
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/out:' + executable,
    path.join(root, 'src', 'intelligence', 'windows-vault.cs'), path.join(__dirname, 'credential-vault-probe.cs'),
  ], { windowsHide: true, stdio: 'inherit' });
}

async function vaultProbe(...args) {
  try {
    await run(executable, args, { windowsHide: true, timeout: 10_000 });
    return 0;
  } catch (error) {
    if (typeof error.code === 'number') return error.code;
    throw error;
  }
}

module.exports = { buildVaultProbe, vaultProbe };
