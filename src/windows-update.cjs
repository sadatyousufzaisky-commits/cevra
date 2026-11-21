const { readFileSync } = require('node:fs');
const fs = require('node:fs/promises');
const { execFile, spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const script = path.join(__dirname, 'windows-update.ps1');
const maxPackageBytes = 1024 ** 3;

function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})$/.test(version)) return null;
  const parts = version.split('.').map(Number);
  return parts[0] <= 255 && parts[1] <= 255 && parts[2] <= 65535 ? parts : null;
}

function installationAt(root) {
  if (process.platform !== 'win32') return null;
  try {
    const item = JSON.parse(readFileSync(path.join(root, 'windows-installation.json'), 'utf8'));
    if (['perUser', 'perMachine'].includes(item.scope) && /^[0-9A-F-]{36}$/.test(item.upgradeCode) &&
        typeof item.signer === 'string' && /^(?:[0-9A-F]{40})?$/.test(item.signer)) return item;
  } catch {}
  return null;
}

async function prepareUpdate(source, installation, version) {
  if (!installation?.signer) throw new Error('This build has no configured publisher for signed updates.');
  if (!path.isAbsolute(source) || path.extname(source).toLowerCase() !== '.msi' || source.startsWith('\\\\')) {
    throw new Error('Select a local Windows Installer package (.msi).');
  }
  const info = await fs.lstat(source);
  if (!info.isFile() || info.size < 1 || info.size > maxPackageBytes) throw new Error('This update package is not a supported file.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vokri-update-'));
  const file = path.join(temporary, 'update.msi');
  const discard = async () => {
    await fs.unlink(file).catch(() => {});
    await fs.rmdir(temporary).catch(() => {});
  };
  const env = { ...process.env, VOKRI_UPDATE_FILE: file, VOKRI_UPDATE_SIGNER: installation.signer,
    VOKRI_UPDATE_SCOPE: installation.scope, VOKRI_UPDATE_FAMILY: installation.upgradeCode, VOKRI_UPDATE_VERSION: version };
  const args = ['-NoProfile', '-NonInteractive', '-File', script];
  try {
    await fs.copyFile(source, file);
    if ((await fs.stat(file)).size > maxPackageBytes) throw new Error('The update package exceeds the size limit.');
    const { stdout } = await run(powershell, args, { env, windowsHide: true, timeout: 60000 });
    const next = stdout.trim();
    if (!versionParts(next)) throw new Error('Windows returned an invalid installer version.');
    return { version: next, discard, launch: () => new Promise((resolve, reject) => {
      const child = spawn(powershell, [...args, '-WaitForEditor', String(process.pid)], {
        env, detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(powershell),
      });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    }) };
  } catch (error) {
    await discard();
    const result = error.stdout?.trim();
    const message = {
      SIGNATURE: 'Windows could not verify this package against the VOKRI Code publisher.',
      IDENTITY: 'This package is for a different product or installation scope.',
      VERSION: 'Choose an update newer than the installed version.',
    }[result];
    throw new Error(message || 'Windows could not verify this update package.');
  }
}

module.exports = { installationAt, prepareUpdate, versionParts };
