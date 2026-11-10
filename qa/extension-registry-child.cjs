const fs = require('node:fs/promises');
const { createExtensionRegistry } = require('../src/extensions/registry.cjs');

const [userData, operation, checkpointName, input] = process.argv.slice(2);
const args = JSON.parse(input);

async function checkpoint(stage) {
  if (stage !== checkpointName) return;
  await new Promise(resolve => {
    process.once('message', resolve);
    process.send({ stage });
  });
}

if (checkpointName === 'partial') {
  const open = fs.open;
  fs.open = async (filename, flags, ...rest) => {
    const handle = await open(filename, flags, ...rest);
    if (flags === 'wx' && filename.endsWith('.tmp')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => {
        const halfway = Math.floor(bytes.length / 2);
        await write(bytes.subarray(0, halfway));
        await checkpoint('partial');
        await write(bytes.subarray(halfway));
      };
    }
    return handle;
  };
}

const registry = createExtensionRegistry(userData, { checkpoint });
Promise.resolve().then(() => registry[operation](...args)).then(
  () => process.disconnect(),
  error => {
    process.send({ error: error.message });
    process.exitCode = 1;
    process.disconnect();
  },
);
