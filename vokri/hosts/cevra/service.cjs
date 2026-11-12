const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { fields, serve } = require('../../bridge/stdio.cjs');
const { createWorkspace, workspacePath, listFolder, readSource, saveSource, saveRecoveryCopy,
  verifyRevision, readInputRevision, maxFileBytes } = require('../../../src/workspace.cjs');
const { normalizeSource } = require('../../../src/source-text.cjs');
const { sourceFileKey } = require('../../../src/source-files.cjs');
const { createDraftStore } = require('../../../src/drafts.cjs');
const { createExecutionSessions } = require('../../../src/execution/sessions.cjs');
const { createTestSession } = require('../../../src/project-tests.cjs');
const { startSourceRun } = require('../../../src/runner.cjs');
const { runtimeKind, typeScriptProfile } = require('../../../src/runtime-kind.cjs');
const { captureInputs, sourceAnchor } = require('../../../src/continuum/revisions.cjs');

const revisionPattern = /^[a-f0-9]{64}$/;
const textLimit = 2 * 1024 * 1024;

function reject(code, message) { throw Object.assign(new Error(message), { code }); }
function shape(args, keys) {
  if (!fields(args, keys)) reject('INVALID_ARGUMENTS', 'The operation received invalid arguments.');
}

function rootPath(value) {
  if (typeof value !== 'string' || value.length > 32760 || !path.isAbsolute(value) || value.includes('\0') ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value))) {
    reject('INVALID_WORKSPACE', 'Choose a project on a local drive.');
  }
  return value;
}

function createCevraService(profile) {
  const drafts = createDraftStore(path.join(rootPath(profile), 'drafts'));
  const tests = createTestSession(os.tmpdir());
  const opened = new Map();
  let workspace;
  let active;
  let lastRun = 0;
  let retryAvailable = false;
  const sessions = createExecutionSessions(event => {
    if (active?.id !== event.runId || event.type !== 'exit') return;
    const finished = active;
    active = undefined;
    retryAvailable = Boolean(event.retryAvailable);
    finished.notify('execution-exit', { ...event, workspaceId: finished.workspace.id });
  });

  function selected(id) {
    if (!workspace || workspace.id !== id) reject('STALE_WORKSPACE', 'The workspace changed. Open the project again.');
    return workspace;
  }

  function relative(project, value) {
    if (typeof value !== 'string' || value.length > 4096) reject('INVALID_PATH', 'Choose a workspace file.');
    return path.relative(project.root, workspacePath(project, value));
  }

  function document(args) {
    const project = selected(args.workspaceId);
    const doc = opened.get(sourceFileKey(relative(project, args.path)));
    if (!doc || (Object.hasOwn(args, 'revision') && args.revision !== doc.revision)) {
      reject('STALE_DOCUMENT', 'Reopen the file before using this revision.');
    }
    return { project, doc };
  }

  async function directory(project, location) {
    const entries = await listFolder(project, location);
    return { path: location, entries: entries.slice(0, 4095), truncated: entries.length > 4095 };
  }

  function matchesRoot(left, right) {
    return sourceFileKey(left) === sourceFileKey(right);
  }

  async function activate(folder, backup = undefined) {
    if (active || sessions.busy) reject('EXECUTION_ACTIVE', 'Stop the current run before switching projects.');
    const project = await createWorkspace(rootPath(folder));
    const listing = await directory(project, '');
    const { entries, unreadable } = backup ?? await drafts.list();
    const recovery = entries.filter(draft => matchesRoot(draft.root, project.root)).map(draft => draft.path).slice(0, 64);
    workspace = project;
    opened.clear();
    retryAvailable = false;
    return { workspace: { id: project.id, root: project.root, name: project.name }, listing, recovery, unreadable };
  }

  function sourceBytes(doc, text) {
    if (typeof text !== 'string' || text.length > textLimit || !text.isWellFormed() || /[\0\r]/.test(text)) {
      reject('INVALID_TEXT', 'Use valid UTF-8 text up to 2 MB.');
    }
    const value = (doc.bom ? '\uFEFF' : '') + (doc.eol === '\n' ? text : text.replaceAll('\n', doc.eol));
    if (Buffer.byteLength(value) > maxFileBytes) reject('INVALID_TEXT', 'Use valid UTF-8 text up to 2 MB.');
    return value;
  }

  async function execution(args, notify) {
    shape(args, ['workspaceId', 'runId', 'kind', 'path', 'revision']);
    const project = selected(args.workspaceId);
    if (active || sessions.busy) reject('EXECUTION_ACTIVE', 'A workspace program is already running.');
    if (!Number.isSafeInteger(args.runId) || args.runId <= lastRun ||
        !['file', 'tests', 'retry'].includes(args.kind)) reject('INVALID_RUN', 'Choose a supported run.');
    if (args.kind !== 'file' && (args.path !== null || args.revision !== null)) reject('INVALID_RUN', 'Invalid test request.');
    if (args.kind === 'retry' && !retryAvailable) reject('INVALID_RUN', 'Run the failing tests first.');
    const attempt = { id: args.runId, token: randomUUID(), workspace: project, notify, stopping: false };
    let source;
    if (args.kind === 'file') {
      const { doc } = document(args);
      if (doc.conflict || !['javascript', 'typescript'].includes(runtimeKind(doc.path))) {
        reject('INVALID_RUN', 'Choose a saved JavaScript or TypeScript source file.');
      }
      await verifyRevision(project, doc.path, doc.revision);
      source = doc;
    }
    lastRun = args.runId;
    active = attempt;
    // Keep control of the pipe while the supervised runner prepares the process.
    void start(attempt, args.kind, source);
    return { runId: attempt.id };
  }

  async function start(attempt, kind, doc) {
    const project = attempt.workspace;
    try {
      const before = await captureInputs(project, [], file => ['javascript', 'typescript'].includes(runtimeKind(file)));
      if (attempt.stopping) {
        active = undefined;
        attempt.notify('execution-exit', { runId: attempt.id, workspaceId: project.id, stopped: true, code: null });
        return;
      }
      await sessions.start(project.id, attempt.id, attempt.token, (publish, stopping) => {
        const isStopping = () => attempt.stopping || stopping();
        const relay = event => {
          if (event.type === 'output' && active === attempt) attempt.notify('execution-output', {
            runId: attempt.id, workspaceId: project.id, text: event.text, truncated: Boolean(event.truncated),
          });
          if (event.type === 'test-failure' && active === attempt && !isStopping() && !attempt.failureLocation) {
            attempt.failureLocation = event.location;
          }
          if (event.type !== 'exit') { publish(event); return; }
          void (async () => {
            let location = null;
            const reported = event.location ?? attempt.failureLocation;
            if (!event.stopped && !isStopping() && reported) {
              try {
                const key = sourceFileKey(relative(project, reported.path));
                const input = await readInputRevision(project, reported.path);
                location = sourceAnchor(project, reported, before, { files: new Map([[key, input]]) });
              } catch {}
            }
            publish({ ...event, stopped: Boolean(event.stopped || isStopping()), location });
          })();
        };
        return kind === 'file'
          ? startSourceRun(project, doc.path, doc.revision, typeScriptProfile, undefined, relay, isStopping)
          : tests.start(project, kind === 'retry', relay, isStopping);
      });
    } catch (error) {
      if (active !== attempt) return;
      active = undefined;
      attempt.notify('execution-exit', {
        runId: attempt.id, workspaceId: project.id, code: null, stopped: attempt.stopping,
        error: typeof error?.message === 'string' ? error.message.slice(0, 512) : 'The runner could not start.',
      });
    }
  }

  async function stop() {
    if (!active) return;
    active.stopping = true;
    await sessions.cancel();
  }

  const routes = {
    async initial(args) {
      shape(args, []);
      const backup = await drafts.list();
      for (const root of new Set(backup.entries.map(entry => entry.root))) {
        try { return await activate(root, backup); } catch {}
      }
      return { workspace: null, unreadable: backup.unreadable || backup.entries.length > 0 };
    },
    open(args) { shape(args, ['folder']); return activate(args.folder); },
    list(args) {
      shape(args, ['workspaceId', 'path']);
      const project = selected(args.workspaceId);
      return directory(project, relative(project, args.path));
    },
    async read(args) {
      shape(args, ['workspaceId', 'path', 'expectedRevision']);
      const project = selected(args.workspaceId);
      const file = relative(project, args.path);
      if (!file) reject('INVALID_PATH', 'Choose a regular file.');
      if (args.expectedRevision !== null && (typeof args.expectedRevision !== 'string' || !revisionPattern.test(args.expectedRevision))) {
        reject('STALE_DOCUMENT', 'The source reference is invalid.');
      }
      const key = sourceFileKey(file);
      if (!opened.has(key) && opened.size >= 64) reject('DOCUMENT_LIMIT', 'Close an editor before opening another file.');
      const backup = (await drafts.list()).entries.find(entry => matchesRoot(entry.root, project.root) && sourceFileKey(entry.path) === key);
      let disk;
      try { disk = await readSource(project, file); }
      catch (error) { if (!backup) throw error; }
      if (args.expectedRevision !== null && (disk?.revision !== args.expectedRevision || backup)) {
        reject('STALE_DOCUMENT', 'The reported source has changed.');
      }
      const { text, revision } = backup ?? disk;
      const doc = { path: backup?.path ?? file, revision, bom: text.startsWith('\uFEFF'),
        eol: /\r\n|\r|\n/.exec(text)?.[0] ?? '\n', conflict: Boolean(backup && backup.revision !== disk?.revision) };
      opened.set(key, doc);
      return { path: doc.path, revision, text: normalizeSource(text), recovered: Boolean(backup), conflict: doc.conflict };
    },
    async draft(args) {
      shape(args, ['workspaceId', 'path', 'revision', 'text']);
      const { project, doc } = document(args);
      await drafts.set(project.root, doc.path, sourceBytes(doc, args.text), doc.revision);
      return {};
    },
    async save(args) {
      shape(args, ['workspaceId', 'path', 'revision', 'text']);
      const { project, doc } = document(args);
      if (doc.conflict) reject('STALE_DOCUMENT', 'Save a recovery copy of this draft.');
      doc.revision = await saveSource(project, doc.path, sourceBytes(doc, args.text), doc.revision);
      const draftCleared = await drafts.set(project.root, doc.path, null, doc.revision).then(() => true, () => false);
      return { revision: doc.revision, draftCleared };
    },
    async 'save-copy'(args) {
      shape(args, ['workspaceId', 'path', 'revision', 'text']);
      const { project, doc } = document(args);
      const file = await saveRecoveryCopy(project, doc.path, sourceBytes(doc, args.text));
      const draftCleared = await drafts.set(project.root, doc.path, null, doc.revision).then(() => true, () => false);
      return { path: file, draftCleared };
    },
    async 'discard-draft'(args) {
      shape(args, ['workspaceId', 'path', 'revision']);
      const { project, doc } = document(args);
      await drafts.set(project.root, doc.path, null, doc.revision);
      opened.delete(sourceFileKey(doc.path));
      return {};
    },
    'close-document'(args) {
      shape(args, ['workspaceId', 'path', 'revision']);
      const { doc } = document(args);
      opened.delete(sourceFileKey(doc.path));
      return {};
    },
    run: execution,
    async stop(args) {
      shape(args, ['workspaceId', 'runId']);
      selected(args.workspaceId);
      if (active?.id === args.runId) await stop();
      return {};
    },
    async shutdown(args) {
      shape(args, []);
      await stop();
      return {};
    },
  };
  return { routes, async close() { await stop(); tests.dispose(); } };
}

if (require.main === module) {
  const service = createCevraService(process.argv[2]);
  serve(process.stdin, process.stdout, service.routes, service.close).catch(() => { process.exitCode = 1; });
}

module.exports = { createCevraService };
