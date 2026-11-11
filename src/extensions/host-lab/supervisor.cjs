const { spawn } = require('node:child_process');
const path = require('node:path');

const artifacts = path.resolve(__dirname, '..', '..', '..', 'dist', 'extension-host-lab');
const maxRequest = 256 * 1024;
const maxResponse = 1024;
const guestErrors = new Set(['engine-unavailable', 'invalid-module', 'imports-denied', 'quota-or-trap', 'invalid-entry']);

function hostError(code, message) { return Object.assign(new Error(message), { code }); }

async function openIsolationLab(scratch, { mode = 'worker', deadline = 5000 } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !path.isAbsolute(scratch) ||
      !['worker', 'probe'].includes(mode) || !Number.isInteger(deadline) || deadline < 50 || deadline > 15000) {
    throw hostError('HOST_CONFIGURATION', 'Use the Windows x64 isolation lab with a trusted scratch directory.');
  }
  const child = spawn(path.join(artifacts, 'extension-launcher.exe'), [String(process.pid), artifacts, scratch, mode], {
    // The launcher watches the owner handle and must survive its exit long enough to clean up.
    stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true,
  });
  let pending;
  let buffer = Buffer.alloc(0);
  let stderr = '';
  let fallback;
  let stopping = false;
  let ended = false;
  let used = false;
  let terminalError;
  let diagnosticBytes = 0;
  let finish;
  const closed = new Promise(resolve => { finish = resolve; });

  function settle(error, frame) {
    if (!pending) return;
    const { resolve, reject, timer } = pending;
    pending = undefined;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(frame);
  }

  function stop(error = hostError('HOST_STOPPED', 'The isolation host was stopped.')) {
    if (!ended) terminalError ??= error;
    settle(error);
    if (!stopping && !ended) {
      stopping = true;
      child.stdin.end();
      // Closing stdin cancels through the launcher. Killing it closes the job if a pipe is blocked.
      fallback = setTimeout(() => child.kill(), 1500);
      fallback.unref();
    }
    return closed;
  }

  function wait(types, limit) {
    if (pending || stopping || ended) throw hostError('HOST_STATE', 'The isolation host cannot accept this request.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => void stop(hostError('HOST_TIMEOUT', 'The isolation host exceeded its deadline.')), limit);
      pending = { types, timer, resolve, reject };
    });
  }

  function malformed() { void stop(hostError('HOST_PROTOCOL', 'The isolation host returned an invalid frame.')); }

  child.stdout.on('data', chunk => {
    if (stopping) return;
    if (buffer.length + chunk.length > maxResponse + 4) { malformed(); return; }
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 4) return;
    const length = buffer.readUInt32LE();
    if (length < 1 || length > maxResponse || buffer.length > length + 4) { malformed(); return; }
    if (buffer.length < length + 4) return;
    const type = buffer[4];
    if (!pending?.types.includes(type)) { malformed(); return; }
    const payload = buffer.subarray(5);
    buffer = Buffer.alloc(0);
    settle(undefined, { type, payload });
  });
  child.stderr.on('data', chunk => {
    if (stopping) return;
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > 8192) {
      void stop(hostError('HOST_QUOTA', 'The isolation host exceeded its diagnostic output budget.'));
      return;
    }
    stderr = (stderr + chunk.toString('utf8')).slice(-2048);
  });
  child.stdin.on('error', () => {}); // The close event reports the process outcome.
  child.once('error', error => settle(hostError('HOST_LAUNCH', error.message)));
  child.once('close', (code, signal) => {
    ended = true;
    clearTimeout(fallback);
    const status = code == null ? signal : '0x' + (code >>> 0).toString(16);
    settle(hostError('HOST_EXIT', stderr.trim() || 'The isolation host exited before replying (' + status + ').'));
    finish({ code, signal, stderr });
  });

  async function send(type, payload, expected) {
    if (payload.length + 1 > maxRequest) throw hostError('HOST_QUOTA', 'The request exceeds 256 KiB.');
    const reply = wait(expected, deadline);
    const header = Buffer.alloc(5);
    header.writeUInt32LE(payload.length + 1);
    header[4] = type;
    child.stdin.write(Buffer.concat([header, payload]));
    return reply;
  }

  async function finishRequest() {
    const timeout = setTimeout(() => void stop(hostError('HOST_TIMEOUT', 'The isolation host did not exit after replying.')), deadline);
    try {
      const { code, stderr } = await closed;
      if (terminalError) throw terminalError;
      if (code !== 0) throw hostError('HOST_EXIT', stderr.trim() || 'The isolation host did not exit cleanly.');
    } finally { clearTimeout(timeout); }
  }

  try {
    const { payload } = await wait([16], 12000);
    if (payload.length !== 8 || payload.readUInt32LE() !== 1 || !payload.readUInt32LE(4)) {
      throw hostError('HOST_PROTOCOL', 'The isolation host greeting was invalid.');
    }
    const pid = payload.readUInt32LE(4);
    return {
      pid,
      launcherPid: child.pid,
      closed,
      stop,
      async ping() {
        if (used || mode !== 'worker') throw hostError('HOST_STATE', 'The host cannot answer a heartbeat.');
        const { payload } = await send(1, Buffer.alloc(0), [17]);
        if (payload.length) { malformed(); throw hostError('HOST_PROTOCOL', 'The heartbeat response was invalid.'); }
      },
      async run(bytes) {
        if (used || mode !== 'worker' || !Buffer.isBuffer(bytes) || !bytes.length) {
          throw hostError('HOST_STATE', 'Choose a core WebAssembly module for the unused host.');
        }
        if (bytes.length + 1 > maxRequest) throw hostError('HOST_QUOTA', 'The module exceeds the request size limit.');
        used = true;
        const reply = await send(2, bytes, [18, 19]);
        await finishRequest();
        if (reply.type === 18 && reply.payload.length === 4) return reply.payload.readInt32LE();
        if (reply.type === 19 && guestErrors.has(reply.payload.toString('ascii'))) {
          throw hostError('GUEST_REJECTED', reply.payload.toString('ascii'));
        }
        malformed();
        throw hostError('HOST_PROTOCOL', 'The module response was invalid.');
      },
      async probe(type, bytes = Buffer.alloc(0)) {
        if (used || mode !== 'probe' || ![3, 4, 5, 6, 7, 8].includes(type) || !Buffer.isBuffer(bytes) || bytes.length > 4095) {
          throw hostError('HOST_STATE', 'Choose a lab probe for the unused host.');
        }
        used = true;
        const reply = await send(type, bytes, [20]);
        await finishRequest();
        if (reply.payload.length === 4) return reply.payload.readUInt32LE();
        malformed();
        throw hostError('HOST_PROTOCOL', 'The probe response was invalid.');
      },
    };
  } catch (error) {
    await stop(error);
    throw error;
  }
}

module.exports = { artifacts, openIsolationLab };
