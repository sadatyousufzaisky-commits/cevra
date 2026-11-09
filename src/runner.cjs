const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { stripVTControlCharacters } = require('node:util');
const { startProcess } = require('./execution/process-host.cjs');
const { resolveEntry, verifyRevision } = require('./workspace.cjs');
const { nodeFile, sourceLocation } = require('./source-location.cjs');

async function startNodeRun(workspace, relative, revision, publish, isStopping = () => false) {
  if (typeof relative !== 'string' || !nodeFile.test(relative)) {
    throw new Error('Select a .js, .mjs, or .cjs file to run.');
  }
  const { file } = await verifyRevision(workspace, relative, revision);
  if (isStopping()) {
    publish({ type: 'exit', code: null, elapsed: 0, stopped: true });
    return;
  }
  return startProcess(workspace.root, [file], event => {
    if (event.type !== 'exit') {
      publish(event);
      return;
    }
    const { stderr, ...exit } = event;
    const detail = !exit.stopped && exit.code !== 0 ? stripVTControlCharacters(stderr) : '';
    publish({
      ...exit,
      location: detail ? sourceLocation(workspace.root, detail) : null,
      summary: /^[A-Za-z]*Error(?: \[[^\]]+\])?: [^\r\n]+/m.exec(detail)?.[0],
    });
  });
}

async function startNodeTests(workspace, stateFile, publish, isStopping = () => false) {
  const root = await resolveEntry(workspace, '');
  if (isStopping()) {
    publish({ type: 'exit', code: null, elapsed: 0, stopped: true });
    return;
  }
  const reporter = pathToFileURL(path.join(__dirname, 'node-reporter.cjs')).href;
  const prefix = 'CEVRA-' + randomUUID() + ' ';
  return startProcess(root, [
    '--test', '--no-strip-types', '--test-reporter=' + reporter, '--test-rerun-failures=' + stateFile,
  ], publish, prefix);
}

module.exports = { startNodeRun, startNodeTests };
