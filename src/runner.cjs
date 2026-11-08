const { execFile, spawn } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { stripVTControlCharacters } = require('node:util');
const { resolveEntry, verifyRevision } = require('./workspace.cjs');
const { nodeFile, sourceLocation } = require('./source-location.cjs');

const maxOutput = 160_000;

async function startNodeRun(workspace, relative, revision, publish) {
  if (typeof relative !== 'string' || !nodeFile.test(relative)) {
    throw new Error('Select a .js, .mjs, or .cjs file to run.');
  }
  const { file } = await verifyRevision(workspace, relative, revision);
  return startProcess(workspace.root, [file], publish);
}

async function startNodeTests(workspace, stateFile, publish) {
  const root = await resolveEntry(workspace, '');
  const reporter = pathToFileURL(path.join(__dirname, 'node-reporter.cjs')).href;
  return startProcess(root, [
    '--test',
    '--no-strip-types',
    '--test-reporter=' + reporter,
    '--test-rerun-failures=' + stateFile,
  ], publish, true);
}

function startProcess(root, args, publish, testMode = false) {
  const windows = process.platform === 'win32';
  const stdio = ['ignore', 'pipe', 'pipe'];
  if (testMode) stdio.push('ipc');
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: !windows,
    stdio,
    windowsHide: true,
  });
  const started = Date.now();
  let pending = '';
  let stderr = '';
  let timer;
  let stopped = false;
  let closed = false;
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
      if (!testMode && name === 'stderr') {
        stderr = (stderr + text).slice(-maxOutput);
      }
      pending = (pending + text).slice(-maxOutput);
      timer ??= setTimeout(flush, 35);
    });
  }

  if (testMode) child.on('message', publish);
  child.on('error', error => { spawnError = error.message; });
  child.once('close', (code, signal) => {
    closed = true;
    flush();
    const failed = !testMode && !stopped && code !== 0;
    const detail = failed ? stripVTControlCharacters(stderr) : '';
    publish({
      type: 'exit',
      code,
      signal,
      stopped,
      error: spawnError,
      elapsed: Date.now() - started,
      location: failed ? sourceLocation(root, detail) : null,
      summary: /^[A-Za-z]*Error(?: \[[^\]]+\])?: [^\r\n]+/m.exec(detail)?.[0],
    });
  });

  return {
    stop() {
      if (closed || stopped || !child.pid) return;
      stopped = true;
      if (windows) {
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, error => {
          if (error) {
            child.kill();
            child.stdout.destroy();
            child.stderr.destroy();
            if (child.connected) child.disconnect();
          }
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

module.exports = { startNodeRun, startNodeTests };
