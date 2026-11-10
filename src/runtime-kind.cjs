const nodeFile = /\.(?:js|cjs|mjs)$/i;
const typeScriptFile = /(?<!\.d)\.(?:ts|cts|mts)$/i;
const pythonFile = /\.py$/i;
const typeScriptProfile = 'node-typescript';

function runtimeKind(file) {
  if (typeof file !== 'string') return null;
  if (nodeFile.test(file)) return 'javascript';
  if (typeScriptFile.test(file)) return 'typescript';
  if (pythonFile.test(file)) return 'python';
  return null;
}

module.exports = { nodeFile, pythonFile, runtimeKind, typeScriptProfile };
