const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { inside } = require('../workspace.cjs');

async function findGit(root) {
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const folder of (process.env.PATH ?? '').split(path.delimiter).map(item => item.replace(/^"|"$/g, ''))) {
    if (!path.isAbsolute(folder) || inside(root, folder)) continue;
    const file = await fs.realpath(path.join(folder, name)).catch(() => null);
    if (file && !inside(root, file) && (await fs.stat(file).catch(() => null))?.isFile()) return file;
  }
  throw new Error('Git was not found on PATH. Install Git and restart CEVRA.');
}

function gitCommand(executable, root, configuration = []) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' });
  const prefix = ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'protocol.allow=never', ...configuration];
  return (args, { input, codes = [0], limit = 1024 * 1024, truncate = false, indexFile } = {}) => new Promise((resolve, reject) => {
    const child = spawn(executable, [...prefix, ...args], {
      cwd: root, env: indexFile ? { ...env, GIT_INDEX_FILE: indexFile } : env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    let bytes = 0;
    let error = '';
    let clipped = false;
    let failed;
    function abort(reason) {
      failed ??= new Error(reason);
      child.kill();
    }
    const timer = setTimeout(() => abort('Git did not respond in time.'), 12_000);
    child.stdout.on('data', chunk => {
      if (bytes + chunk.length > limit) {
        clipped = true;
        if (!truncate) return abort('The Git result exceeded the review limit.');
      }
      if (bytes >= limit) return;
      const next = chunk.subarray(0, limit - bytes);
      bytes += next.length;
      chunks.push(next);
    });
    child.stderr.setEncoding('utf8').on('data', text => { error = (error + text).slice(-4096); });
    child.stdin.on('error', () => {});
    child.on('error', reason => { failed = reason; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || !codes.includes(code)) reject(failed ?? new Error(error.trim() || 'Git could not complete the operation.'));
      else resolve({ code, bytes: Buffer.concat(chunks, bytes), clipped, error });
    });
    child.stdin.end(input);
  });
}

module.exports = { findGit, gitCommand };
