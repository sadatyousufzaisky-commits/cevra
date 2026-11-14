const { spawn } = require('node:child_process');
const path = require('node:path');
const { createReportDecoder } = require('./test-report.cjs');

const maxOutput = 160_000;
const windows = process.platform === 'win32';
const windowsHost = path.resolve(__dirname, '..', '..', 'dist', 'vokri-process-host.exe');

function startProcess(root, args, publish, reportPrefix, { executable = process.execPath, environment, stderrFilter } = {}) {
  const env = { ...process.env, ...environment };
  if (executable === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  if (reportPrefix) env.CEVRA_TEST_REPORT_PREFIX = reportPrefix;
  else delete env.CEVRA_TEST_REPORT_PREFIX;
  const child = spawn(windows ? windowsHost : executable, windows ? [String(process.pid), executable, ...args] : args, {
    cwd: root, env, detached: !windows, windowsHide: true,
    stdio: [windows ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const started = performance.now();
  let pending = '';
  let dropped = false;
  let timer;
  let stopTimer;
  let stopped = false;
  let exited = false;
  let spawnError;

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (pending) {
      publish({ type: 'output', text: pending, truncated: dropped });
      pending = '';
      dropped = false;
    }
  }

  function output(text) {
    if (!text) return;
    if (pending.length + text.length > maxOutput) dropped = true;
    pending = (pending + text).slice(-maxOutput);
    timer ??= setTimeout(flush, 35);
  }

  const report = reportPrefix && createReportDecoder(reportPrefix, publish, output);
  let stderr = '';
  function appendStderr(text) {
    if (!report) stderr = (stderr + text).slice(-maxOutput);
    output(text);
  }
  child.stdout.setEncoding('utf8').on('data', text => {
    if (report) report.write(text);
    else output(text);
  });
  child.stderr.setEncoding('utf8').on('data', text => appendStderr(stderrFilter ? stderrFilter.write(text) : text));
  child.stdin?.on('error', () => {}); // The native supervisor may exit before Stop closes its pipe.
  child.once('error', error => { spawnError = error.message; });

  function stopGroup() {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH' && !exited) child.kill('SIGKILL');
    }
  }

  child.once('exit', () => {
    exited = true;
    clearTimeout(stopTimer);
    if (!windows) stopGroup();
  });
  child.once('close', (code, signal) => {
    exited = true;
    clearTimeout(stopTimer);
    report?.finish();
    if (stderrFilter) appendStderr(stderrFilter.finish());
    flush();
    publish({ type: 'exit', code, signal, stopped, error: spawnError, stderr, elapsed: Math.round(performance.now() - started) });
  });

  return {
    stop() {
      if (exited || stopped) return;
      stopped = true;
      if (windows) {
        child.stdin.end();
        stopTimer = setTimeout(() => child.kill('SIGKILL'), 6500);
        stopTimer.unref();
      } else {
        stopGroup();
      }
    },
  };
}

module.exports = { startProcess, maxOutput };
