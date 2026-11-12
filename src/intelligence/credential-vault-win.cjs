const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const executable = path.resolve(__dirname, '../../dist/cevra-credential-vault.exe');
const available = () => process.platform === 'win32' && process.arch === 'x64' && existsSync(executable);

function invoke(action, scope, provider, reference, { owner, signal } = {}) {
  if (!available()) return Promise.resolve('unavailable');
  if (signal?.aborted) return Promise.resolve('cancelled');
  const args = [action, scope, provider, reference];
  if (action === 'prompt') args.push(owner.handle, String(owner.pid));
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executable, args, {
        stdio: 'ignore', windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', TEMP: process.env.TEMP, TMP: process.env.TMP },
      });
    }
    catch { resolve('unavailable'); return; }
    let timedOut = false;
    const cancel = () => { child.kill(); };
    const timer = setTimeout(() => { timedOut = true; cancel(); }, action === 'prompt' ? 300_000 : 8000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.once('error', () => {});
    // Wait for process closure before the caller removes a possibly staged key.
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) resolve('cancelled');
      else if (timedOut) resolve('unavailable');
      else resolve(({ 0: 'ok', 2: 'cancelled', 3: 'missing' })[code] ?? 'unavailable');
    });
  });
}

function createWindowsCredentialVault() {
  return Object.freeze({
    available,
    prompt: (scope, provider, reference, owner, signal) => invoke('prompt', scope, provider, reference, { owner, signal }),
    inspect: (scope, provider, reference) => invoke('inspect', scope, provider, reference),
    remove: (scope, provider, reference) => invoke('delete', scope, provider, reference),
  });
}

module.exports = { createWindowsCredentialVault };
