const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function writeAtomic(file, text, { mode = 0o600, beforeCommit } = {}) {
  const temporary = path.join(path.dirname(file), '.cevra-' + randomUUID() + '.tmp');
  const handle = await fs.open(temporary, 'wx', mode);
  let committed = false;
  try {
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (beforeCommit) await beforeCommit();
    await fs.rename(temporary, file);
    committed = true;
  } finally {
    if (!committed) await fs.unlink(temporary).catch(() => {});
  }
}

module.exports = { writeAtomic };
