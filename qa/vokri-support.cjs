const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const output = path.resolve(__dirname, '..', 'dist', 'vokri');
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

async function compile(name, source, options) {
  const file = path.join(output, name + '.exe');
  await execute(compiler, ['/nologo', '/platform:x64', '/target:exe', '/warnaserror+', '/out:' + file,
    ...options, path.join(__dirname, source)], { windowsHide: true, timeout: 15000 });
  return file;
}

async function until(read, predicate, message) {
  const deadline = Date.now() + 10000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(70);
  } while (Date.now() < deadline);
  assert.fail(message + ' Last value: ' + value);
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

module.exports = { compile, until, processExists };
