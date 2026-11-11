const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openIsolationLab } = require('./host-lab/supervisor.cjs');

function supportedRuntime() {
  return process.platform === 'win32' && process.arch === 'x64' &&
    ['10.0.26100', '10.0.26300'].includes(os.release());
}

async function startExtensionHost(onRequest) {
  if (!supportedRuntime()) throw Object.assign(new Error('Executable extensions require a verified Windows x64 build.'), { code: 'PERMISSION_DENIED' });
  const temporary = await fs.realpath(os.tmpdir());
  const scratch = await fs.mkdtemp(path.join(temporary, 'cevra-extension-'));
  try {
    const host = await openIsolationLab(scratch, { onRequest, deadline: 15000 });
    void host.closed.then(() => fs.rmdir(scratch)).catch(() => {});
    return host;
  } catch (error) {
    await fs.rmdir(scratch).catch(() => {});
    throw error;
  }
}

module.exports = { startExtensionHost, supportedRuntime };
