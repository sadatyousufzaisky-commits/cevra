const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function temporaryFolder(t, prefix) {
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, prefix));
  t.after(async () => {
    const resolved = await fs.realpath(folder);
    assert.equal(resolved, folder);
    assert.equal(path.dirname(resolved), parent);
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return folder;
}

module.exports = { temporaryFolder };
