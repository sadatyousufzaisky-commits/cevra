const { execFile, spawn } = require('node:child_process');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { stripVTControlCharacters } = require('node:util');
const { inside, resolveEntry, verifyRevision } = require('./workspace.cjs');

const nodeFile = /\.(?:js|cjs|mjs)$/i;
const maxOutput = 160_000;

function sourceLocation(root, stderr) {
  const lines = stderr.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    let value = trimmed;
    if (trimmed.startsWith('at ')) {
      const frame = trimmed.lastIndexOf(' (');
      value = frame !== -1 && trimmed.endsWith(')')
        ? trimmed.slice(frame + 2, -1)
        : trimmed.replace(/^at (?:async )?/, '');
    }

    const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(value);
    if (!match) continue;
    let [, file, row, column] = match;
    if (file.startsWith('file://')) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (!path.isAbsolute(file) || !inside(root, file)) continue;
    const relative = path.relative(root, file);
    if (!nodeFile.test(relative) || relative.split(path.sep).includes('node_modules')) continue;
    const caret = /^\s*\^/.test(lines[index + 2] || '') ? lines[index + 2].indexOf('^') + 1 : 1;
    return { path: relative, line: Number(row), column: column ? Number(column) : caret };
  }
  return null;
}

async function startNodeRun(workspace, relative, revision, publish) {
  const file = await resolveEntry(workspace, relative);
  if (!nodeFile.test(file)) throw new Error('Select a .js, .mjs, or .cjs file to run.');
  await verifyRevision(file, revision);
  const windows = process.platform === 'win32';
  const child = spawn(process.execPath, [file], {
    cwd: workspace.root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: !windows,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const started = Date.now();
  let pending = '';
  let stderr = '';
  let timer;
  let stopped = false;
  let spawnError;

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (pending) {
      publish({ type: 'output', text: pending });
      pending = '';
    }
  }

  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.setEncoding('utf8');
    stream.on('data', text => {
      if (name === 'stderr' && stderr.length < maxOutput) {
        stderr += text.slice(0, maxOutput - stderr.length);
      }
      pending = (pending + text).slice(-maxOutput);
      timer ??= setTimeout(flush, 35);
    });
  }

  child.on('error', error => { spawnError = error.message; });
  child.once('close', (code, signal) => {
    flush();
    const failed = !stopped && code !== 0;
    const detail = failed ? stripVTControlCharacters(stderr) : '';
    publish({
      type: 'exit',
      code,
      signal,
      stopped,
      error: spawnError,
      elapsed: Date.now() - started,
      location: failed ? sourceLocation(workspace.root, detail) : null,
      summary: /^[A-Za-z]*Error(?: \[[^\]]+\])?: [^\r\n]+/m.exec(detail)?.[0],
    });
  });

  return {
    stop() {
      if (stopped || !child.pid) return;
      stopped = true;
      if (windows) {
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, error => {
          if (error) child.kill();
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
    },
  };
}

module.exports = { startNodeRun };
