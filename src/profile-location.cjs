const { statSync } = require('node:fs');
const path = require('node:path');
const { productName } = require('./identity.cjs');

function exists(directory) {
  try {
    if (!statSync(directory).isDirectory()) throw new Error('The profile path is occupied by a file.');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function profileLocation(appData, override) {
  if (override !== undefined) {
    if (!path.isAbsolute(override)) throw new Error('The profile override must be an absolute path.');
    return { directory: override, state: 'custom' };
  }
  const directory = path.join(appData, productName);
  const legacy = path.join(appData, 'CEVRA');
  const brandedExists = exists(directory);
  if (!exists(legacy)) return { directory, state: 'current' };
  // Credentials use the canonical profile path. Reuse it without copying or merging state.
  return brandedExists ? { directory, state: 'separate' } : { directory: legacy, state: 'retained' };
}

module.exports = { profileLocation };
