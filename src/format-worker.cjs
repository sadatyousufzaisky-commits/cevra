const { parentPort } = require('node:worker_threads');
const { readFormatOptions, lineEndings } = require('./format-options.cjs');
const { formatSource } = require('./format-source.cjs');

parentPort.on('message', async ({ id, workspace, file, text, eol, bom, extension }) => {
  try {
    const options = await readFormatOptions(workspace, file);
    const ending = lineEndings[options.lineEnding] ?? eol;
    const changes = formatSource(extension, text, options, ending, bom);
    parentPort.postMessage({ id, result: { changes, eol: ending } });
  } catch (error) {
    const detail = error.message.split(/\r?\n/, 1)[0].slice(0, 280);
    parentPort.postMessage({ id, error: 'Could not format this document. ' + detail });
  }
});
