const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const executable = path.resolve(__dirname, '../../dist/vokri-credential-vault.exe');
const available = () => process.platform === 'win32' && process.arch === 'x64' && existsSync(executable);
const keyLimit = 2048;

function invoke(action, scope, provider, reference, { owner, signal } = {}) {
  if (!available()) return Promise.resolve('unavailable');
  if (signal?.aborted) return Promise.resolve('cancelled');
  const args = [action, scope, provider, reference];
  if (action === 'prompt') args.push(owner.handle, String(owner.pid));
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executable, args, {
        stdio: action === 'read' ? ['ignore', 'pipe', 'ignore'] : 'ignore', windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', TEMP: process.env.TEMP, TMP: process.env.TMP },
      });
    }
    catch { resolve('unavailable'); return; }
    let timedOut = false;
    let overflow = false;
    const secret = action === 'read' ? Buffer.alloc(keyLimit) : null;
    let received = 0;
    const cancel = () => { child.kill(); };
    child.stdout?.on('data', chunk => {
      if (!overflow && received + chunk.length <= keyLimit) {
        chunk.copy(secret, received);
        received += chunk.length;
      } else { overflow = true; cancel(); }
      chunk.fill(0);
    });
    child.stdout?.on('error', () => { overflow = true; cancel(); });
    const timer = setTimeout(() => { timedOut = true; cancel(); }, action === 'prompt' ? 300_000 : 8000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.once('error', () => {});
    // Wait for process closure before the caller removes a possibly staged key.
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (secret && code === 0 && !overflow && !timedOut && !signal?.aborted && received > 0 &&
          secret.subarray(0, received).every(byte => byte >= 0x21 && byte <= 0x7e)) {
        resolve(secret.subarray(0, received));
        return;
      }
      secret?.fill(0);
      if (signal?.aborted) resolve('cancelled');
      else if (action === 'read' && code === 0) resolve('unavailable');
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
    read: (scope, provider, reference, signal) => invoke('read', scope, provider, reference, { signal }),
    remove: (scope, provider, reference) => invoke('delete', scope, provider, reference),
  });
}

module.exports = { createWindowsCredentialVault };
