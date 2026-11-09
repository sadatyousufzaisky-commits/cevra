const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const maxSessions = 4;
const maxTerminalInput = 16 * 1024;
const maxControlQueue = 64 * 1024;
const maxRead = 32 * 1024;
const windowsHost = path.resolve(__dirname, '..', '..', 'dist', 'cevra-process-host.exe');
const profiles = {
  powershell: {
    name: 'PowerShell', file: ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
    args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command',
      'try { [Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
      'Set-Location -LiteralPath $env:CEVRA_TERMINAL_ROOT -ErrorAction Stop } ' +
      'catch { Write-Error $_; exit 1 } finally { Remove-Item Env:CEVRA_TERMINAL_ROOT }; ' +
      'if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) { Set-PSReadLineOption -HistorySaveStyle SaveNothing }'],
  },
  cmd: { name: 'Command Prompt', file: ['cmd.exe'], args: [] },
};

function terminalProfile(id) {
  if (typeof id !== 'string' || !Object.hasOwn(profiles, id)) throw new Error('Choose a supported terminal profile.');
  return profiles[id];
}

function validateSize(columns, rows) {
  if (!Number.isInteger(columns) || columns < 2 || columns > 500 ||
      !Number.isInteger(rows) || rows < 2 || rows > 200) throw new Error('Invalid terminal size.');
}

function createTerminalSessions() {
  const sessions = new Map();

  function sessionFor(workspaceId, id) {
    const session = sessions.get(id);
    if (!session || session.workspaceId !== workspaceId) throw new Error('This terminal session has closed.');
    return session;
  }

  function start(workspaceId, root, id, columns, rows) {
    if (process.platform !== 'win32') throw new Error('The live terminal requires Windows.');
    if (sessions.size >= maxSessions) throw new Error('Close a terminal before opening another.');
    validateSize(columns, rows);
    const profile = terminalProfile(id);
    if (id === 'cmd' && root.startsWith('\\\\')) throw new Error('Command Prompt needs a local working directory. Choose PowerShell.');
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...profile.file);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.CEVRA_TERMINAL_ROOT = root;
    const child = spawn(windowsHost, [String(process.pid), '--terminal', String(columns), String(rows), root, executable, ...profile.args], {
      cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const sessionId = randomUUID();
    const session = { workspaceId, child, columns, rows, error: '', closing: false };
    let complete;
    session.finished = new Promise(resolve => { complete = resolve; });
    sessions.set(sessionId, session);

    // Leave output in the readable stream until the renderer has room for it.
    child.stdout.on('readable', holdOutput);
    child.stderr.setEncoding('utf8').on('data', text => {
      session.error = (session.error + text).slice(-4_096);
    });
    child.stdin.on('error', () => {});
    child.once('error', error => { session.error = error.message; });
    child.once('close', (code, signal) => {
      clearTimeout(session.stopTimer);
      session.exit = { code, signal, error: session.error.trim() };
      complete();
    });
    return { id: sessionId, profile: profile.name, root };
  }

  function writeControl(session, frame) {
    const { stdin } = session.child;
    if (session.closing || session.exit || !stdin.writable) throw new Error('This terminal is no longer accepting input.');
    if (stdin.writableLength + frame.length > maxControlQueue) throw new Error('The terminal input queue is full.');
    return new Promise((resolve, reject) => {
      stdin.write(frame, error => error ? reject(error) : resolve());
    });
  }

  function close(session) {
    if (!session.exit && !session.closing) {
      session.closing = true;
      session.child.stdout.off('readable', holdOutput);
      session.child.stdout.resume();
      session.child.stdin.end();
      session.stopTimer = setTimeout(() => session.child.kill('SIGKILL'), 6500);
      session.stopTimer.unref();
    }
    return session.finished;
  }

  return {
    maxSessions,
    get liveCount() { return [...sessions.values()].filter(session => !session.exit).length; },
    start,
    assertSession(workspaceId, id) { sessionFor(workspaceId, id); },
    read(workspaceId, id) {
      const { child: { stdout }, exit } = sessionFor(workspaceId, id);
      const count = Math.min(stdout.readableLength, maxRead);
      // A zero-byte read lets the paused stream deliver EOF after the last output.
      return { data: stdout.read(count), exit };
    },
    write(workspaceId, id, text) {
      const session = sessionFor(workspaceId, id);
      if (typeof text !== 'string' || !text.length || Buffer.byteLength(text) > maxTerminalInput) {
        throw new Error('Terminal input must fit within 16 KiB.');
      }
      return writeControl(session, 'i:' + Buffer.from(text).toString('base64') + '\n');
    },
    async resize(workspaceId, id, columns, rows) {
      const session = sessionFor(workspaceId, id);
      validateSize(columns, rows);
      if (session.exit || session.closing || (session.columns === columns && session.rows === rows)) return;
      await writeControl(session, 'r:' + columns + ',' + rows + '\n');
      session.columns = columns;
      session.rows = rows;
    },
    async close(workspaceId, id) {
      const session = sessionFor(workspaceId, id);
      await close(session);
      sessions.delete(id);
    },
    async closeAll() {
      const entries = [...sessions];
      await Promise.all(entries.map(([, session]) => close(session)));
      for (const [id] of entries) sessions.delete(id);
    },
  };
}

function holdOutput() {}

module.exports = { createTerminalSessions, terminalProfile, validateSize, maxTerminalInput };
