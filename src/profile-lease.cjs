const { spawn } = require('node:child_process');
const path = require('node:path');

const host = path.join(__dirname, '..', 'dist', 'vokri-process-host.exe');

function profileError(code, message) {
  return Object.assign(new Error(message), { code });
}

function acquireProfileLease(directory, onLost = () => process.exit(1)) {
  if (process.platform !== 'win32') return Promise.resolve({ async release() {} });
  return new Promise((resolve, reject) => {
    const child = spawn(host, [String(process.pid), '--profile-lease', directory], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    let held = false;
    let released = false;
    let response = '';
    const stopped = new Promise(resolve => {
      child.once('close', resolve);
    });
    function release() {
      if (!released) {
        released = true;
        child.stdin.end();
      }
      return stopped;
    }
    const deadline = setTimeout(() => {
      release();
      child.kill();
      reject(profileError('PROFILE_UNAVAILABLE', 'VOKRI Code could not acquire access to the profile.'));
    }, 8_000);
    function failed(code) {
      clearTimeout(deadline);
      if (held) {
        if (!released) onLost();
        return;
      }
      reject(code === 73
        ? profileError('PROFILE_BUSY', 'This profile is already open. Close the other VOKRI Code window and try again.')
        : profileError('PROFILE_UNAVAILABLE', 'VOKRI Code could not acquire access to the profile.'));
    }
    child.stdin.on('error', () => {});
    child.once('error', () => failed());
    child.once('exit', failed);
    child.stdout.setEncoding('utf8').on('data', chunk => {
      if (held || released) return;
      response += chunk;
      if (response === 'PROFILE READY\n' || response === 'PROFILE READY\r\n') {
        held = true;
        clearTimeout(deadline);
        resolve({ release });
      } else if (response.length > 32) {
        release();
        child.kill();
        failed();
      }
    });
  });
}

module.exports = { acquireProfileLease };
