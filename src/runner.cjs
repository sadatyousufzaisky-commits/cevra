const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { stripVTControlCharacters } = require('node:util');
const { startProcess } = require('./execution/process-host.cjs');
const { pythonColumn, pythonDiagnostic, typeScriptDiagnostic } = require('./execution/runtime-location.cjs');
const { captureInputs, sourceAnchor } = require('./continuum/revisions.cjs');
const { inputStamp, readInputRevision, resolveEntry, verifyRevision } = require('./workspace.cjs');
const { sourceFileKey } = require('./source-files.cjs');
const { runtimeKind, typeScriptProfile } = require('./runtime-kind.cjs');
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

const adapters = {
  typescript: {
    diagnostic: typeScriptDiagnostic,
    async prepare(profile) {
      if (profile !== typeScriptProfile) throw new Error('Choose the bundled TypeScript runtime.');
      return { args: ['--experimental-transform-types', '--enable-source-maps'] };
    },
  },
  python: {
    diagnostic: pythonDiagnostic,
    async prepare(profile, python) {
      const { file } = await python.resolve(profile);
      return { args: ['-B', '-X', 'utf8', '-u'], executable: file, environment: { PYTHONIOENCODING: 'utf-8' } };
    },
  },
};

async function startSourceRun(workspace, relative, revision, profile, python, publish, isStopping = () => false) {
  const kind = runtimeKind(relative);
  if (kind === 'javascript') return startNodeRun(workspace, relative, revision, publish, isStopping);
  const adapter = adapters[kind];
  if (!adapter) throw new Error('Choose a JavaScript, TypeScript, or Python entry file.');
  const before = await captureInputs(workspace, kind === 'python' ? ['venv'] : [], candidate => {
    const language = runtimeKind(candidate);
    return language === kind || (kind === 'typescript' && language === 'javascript');
  });
  const { args, executable, environment } = await adapter.prepare(profile, python);
  const { file, stat } = await verifyRevision(workspace, relative, revision);
  before.files.set(sourceFileKey(relative), { revision, stamp: inputStamp(stat) });
  if (isStopping()) {
    publish({ type: 'exit', code: null, elapsed: 0, stopped: true });
    return;
  }

  async function finish(event) {
    const { stderr, ...exit } = event;
    const detail = !exit.stopped && !isStopping() && exit.code !== 0 ? stripVTControlCharacters(stderr) : '';
    const { location, pointer, summary } = detail ? adapter.diagnostic(workspace.root, detail) : {};
    let anchor = null;
    if (location && before.files.has(sourceFileKey(location.path))) {
      try {
        const current = await readInputRevision(workspace, location.path);
        anchor = sourceAnchor(workspace, location, before, { files: new Map([[sourceFileKey(location.path), current]]) });
        if (anchor && pointer) {
          const { bytes } = await verifyRevision(workspace, anchor.path, anchor.revision);
          const line = bytes.toString('utf8').split(/\r\n|\n|\r/)[anchor.line - 1];
          anchor.column = pythonColumn(line, pointer);
        }
      } catch { anchor = null; }
    }
    const stopped = Boolean(exit.stopped || isStopping());
    publish({ ...exit, stopped, location: stopped ? null : anchor, summary: stopped ? undefined : summary });
  }

  return startProcess(workspace.root, [...args, file], event => {
    if (event.type === 'exit') void finish(event);
    else publish(event);
  }, undefined, { executable, environment });
}

module.exports = { startNodeRun, startNodeTests, startSourceRun };
