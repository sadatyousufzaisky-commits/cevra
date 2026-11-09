const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { createWorkspace, listFolder, maxFileBytes, readSource, saveSource, saveRecoveryCopy,
  resolveEntry, verifyRevision, workspacePath } = require('./workspace.cjs');
const { sourceFileKey } = require('./source-files.cjs');
const { startNodeRun } = require('./runner.cjs');
const { createTestSession } = require('./project-tests.cjs');
const { createDraftStore } = require('./drafts.cjs');
const { searchProject } = require('./project-search.cjs');
const { createSyntaxService } = require('./syntax-service.cjs');
const { createFormatService } = require('./format-service.cjs');
const { createSemanticService } = require('./semantic-service.cjs');
const { createPreferences } = require('./preferences.cjs');
const { createTestWorkstream } = require('./continuum/workstream.cjs');
const { createExecutionSessions } = require('./execution/sessions.cjs');

app.setName('CEVRA');

const page = path.join(__dirname, 'index.html');
const pageURL = pathToFileURL(page).href;
const tests = createTestSession(app.getPath('temp'));
const drafts = createDraftStore(path.join(app.getPath('userData'), 'drafts'));
const preferences = createPreferences(app.getPath('userData'));
const syntax = createSyntaxService();
const formatter = createFormatService();
const semantics = createSemanticService();
let window;
let workspace;
let workstream;
let changingWorkspace = false;
let runGrant;
let authorizingRun = false;
let activeSearch;
let rendererReady = false;
let closePending = false;
let allowClose = false;
let lastRendererCrash = 0;
const sessions = createExecutionSessions(event => {
  if (workspace?.id === event.workspaceId && rendererReady && window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('cevra:run-event', event);
  }
});

function colorMode() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function windowAppearance(mode) {
  const dark = mode === 'dark';
  return {
    backgroundColor: dark ? '#101417' : '#fcfdfb',
    titleBarOverlay: { color: dark ? '#14191d' : '#eff4ef', symbolColor: dark ? '#e3ebea' : '#182b29', height: 51 },
  };
}

function syncWindowAppearance() {
  if (!window || window.isDestroyed()) return;
  const mode = colorMode();
  const { backgroundColor, titleBarOverlay } = windowAppearance(mode);
  window.setBackgroundColor(backgroundColor);
  if (process.platform === 'win32' || process.platform === 'linux') window.setTitleBarOverlay(titleBarOverlay);
  if (!window.webContents.isDestroyed()) window.webContents.send('cevra:color-mode', mode);
}

nativeTheme.on('updated', syncWindowAppearance);

function isWorkbench(event) {
  return window && event.sender === window.webContents &&
    event.senderFrame?.parent === null && event.senderFrame.url === pageURL;
}

function handle(channel, action) {
  ipcMain.handle(`cevra:${channel}`, (event, ...args) => {
    if (!isWorkbench(event)) throw new Error('Unrecognized workbench.');
    return action(...args);
  });
}

function currentWorkspace(id) {
  if (!workspace || workspace.id !== id) throw new Error('This workspace has closed.');
  return workspace;
}

async function readDrafts() {
  try {
    return await drafts.list();
  } catch {
    return { entries: [], unreadable: true };
  }
}

function ensureWorkspaceAvailable(recovering = false) {
  if (changingWorkspace) throw new Error('A workspace is already opening.');
  if (sessions.busy && (!recovering || rendererReady)) throw new Error('Stop the current run before opening another project.');
}

async function openWorkspace(folder, { entry, discard, recovering = false } = {}) {
  ensureWorkspaceAvailable(recovering);
  changingWorkspace = true;
  runGrant = undefined;
  try {
    if (recovering) await sessions.cancel();
    const next = await createWorkspace(folder);
    const files = await listFolder(next);
    if (discard && workspace) await drafts.clear(workspace.root);
    const { entries, unreadable } = await readDrafts();
    const recovered = entries.filter(draft => draft.root === next.root);
    const settings = await preferences.getEditor(next);
    activeSearch?.controller.abort();
    syntax.stop();
    formatter.stop();
    semantics.stop();
    workspace = next;
    workstream = createTestWorkstream(next, tests.start);
    return {
      id: next.id, root: next.root, name: next.name, files, entry, recovered, unreadable, settings,
      caseInsensitivePaths: process.platform === 'win32',
    };
  } finally {
    changingWorkspace = false;
  }
}

handle('initial', async () => {
  const { entries, unreadable } = await readDrafts();
  const roots = new Set([workspace?.root, ...entries.map(draft => draft.root)]);
  let unavailable = false;
  for (const root of roots) {
    if (!root) continue;
    try {
      return { project: await openWorkspace(root, { recovering: true }), unavailable };
    } catch {
      unavailable = true;
    }
  }
  return { unavailable, unreadable };
});

handle('appearance', () => ({ theme: nativeTheme.themeSource, mode: colorMode() }));
handle('set-theme', async choice => {
  const theme = await preferences.setTheme(choice);
  nativeTheme.themeSource = theme;
  syncWindowAppearance();
  return { theme, mode: colorMode() };
});
handle('editor-settings', id => preferences.getEditor(id ? currentWorkspace(id) : undefined));
handle('set-editor-settings', (id, scope, values) =>
  preferences.setEditor(id ? currentWorkspace(id) : undefined, scope, values));
handle('workspace-trust', id => preferences.isTrusted(currentWorkspace(id)));
handle('revoke-trust', async id => {
  const project = currentWorkspace(id);
  runGrant = undefined;
  await preferences.setTrusted(project, false);
});

handle('authorize-run', async (id, runId) => {
  const project = currentWorkspace(id);
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Invalid execution request.');
  if (authorizingRun || sessions.busy) throw new Error('An execution request is already active.');
  if (changingWorkspace || closePending || allowClose) throw new Error('The workspace is changing.');
  const owner = window.webContents;
  authorizingRun = true;
  runGrant = undefined;
  try {
    await resolveEntry(project, '');
    if (!await preferences.isTrusted(project)) {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Workspace execution',
        message: 'Allow CEVRA to run code from this workspace?',
        detail: project.root + '\n\nCode and tests run with your Windows user permissions.',
        buttons: ['Cancel', 'Run Once', 'Trust Workspace'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1 && response !== 2) return null;
      currentWorkspace(id);
      await resolveEntry(project, '');
      if (response === 2) await preferences.setTrusted(project, true);
    }
    currentWorkspace(id);
    if (changingWorkspace || closePending || allowClose || window?.webContents !== owner || !rendererReady) {
      throw new Error('The execution request expired.');
    }
    const token = randomUUID();
    runGrant = { id, runId, token };
    return token;
  } finally {
    authorizingRun = false;
  }
});

handle('choose-folder', async discard => {
  ensureWorkspaceAvailable();
  const choice = await dialog.showOpenDialog(window, {
    title: 'Open a CEVRA workspace',
    properties: ['openDirectory'],
  });
  if (choice.canceled) return null;
  return openWorkspace(choice.filePaths[0], { discard: discard === true });
});

handle('open-example', async discard => {
  ensureWorkspaceAvailable();
  const folder = path.join(app.getPath('userData'), 'examples', 'first-run');
  await fs.mkdir(folder, { recursive: true });
  for (const [source, destination] of [
    ['hello.js', 'hello.js'],
    ['total.cjs', 'total.cjs'],
    ['weights.fixture', 'weights.test.cjs'],
  ]) {
    try {
      await fs.copyFile(path.join(__dirname, '..', 'examples', source),
        path.join(folder, destination), fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return openWorkspace(folder, { entry: 'hello.js', discard: discard === true });
});

handle('discard', async name => {
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    message: `Discard unsaved changes in ${name}?`,
    buttons: ['Keep editing', 'Discard changes'],
    defaultId: 0,
    cancelId: 0,
  });
  return response === 1;
});

handle('list', (id, folder) => listFolder(currentWorkspace(id), folder));
handle('read', (id, file) => readSource(currentWorkspace(id), file));
handle('syntax', (id, file, text) => {
  const project = currentWorkspace(id);
  if (path.relative(project.root, workspacePath(project, file)) === '') throw new Error('Choose a source file.');
  return syntax.analyze(file, text);
});
handle('format', (id, file, text, eol, bom) => formatter.format(currentWorkspace(id), file, text, eol, bom));
handle('quick-info', (id, file, position, buffers) =>
  semantics.quickInfo(currentWorkspace(id), file, position, buffers));
handle('complete', (id, file, position, buffers) =>
  semantics.complete(currentWorkspace(id), file, position, buffers));
handle('signature-help', (id, file, position, buffers) =>
  semantics.signatureHelp(currentWorkspace(id), file, position, buffers));
handle('definition', (id, file, position, buffers) =>
  semantics.definition(currentWorkspace(id), file, position, buffers));
handle('references', (id, file, position, buffers, requestId) =>
  semantics.references(currentWorkspace(id), file, position, buffers, requestId));
handle('cancel-references', (id, requestId) => semantics.cancelReferences(currentWorkspace(id), requestId));
handle('symbols', (id, query, buffers, requestId) => semantics.symbols(currentWorkspace(id), query, buffers, requestId));
handle('cancel-symbols', (id, requestId) => semantics.cancelSymbols(currentWorkspace(id), requestId));
handle('rename', (id, file, position, buffers, name) =>
  semantics.rename(currentWorkspace(id), file, position, buffers, name));
handle('type-check', (id, file, buffers) => semantics.diagnostics(currentWorkspace(id), file, buffers));
handle('search', async (id, requestId, query, caseSensitive, snapshots) => {
  const project = currentWorkspace(id);
  activeSearch?.controller.abort();
  const search = { id, requestId, controller: new AbortController() };
  activeSearch = search;
  try {
    return await searchProject(project, query, caseSensitive, snapshots, search.controller.signal);
  } finally {
    if (activeSearch === search) activeSearch = undefined;
  }
});
handle('cancel-search', (id, requestId) => {
  if (activeSearch?.id === id && activeSearch.requestId === requestId) activeSearch.controller.abort();
});
handle('save', (id, file, text, revision) => saveSource(currentWorkspace(id), file, text, revision));
handle('stage-edits', async (id, changes) => {
  const project = currentWorkspace(id);
  if (!Array.isArray(changes) || !changes.length || changes.length > 64) throw new Error('Invalid edit batch.');
  const files = new Set();
  let bytes = 0;
  for (const change of changes) {
    const key = sourceFileKey(workspacePath(project, change.path));
    if (files.has(key) || typeof change.text !== 'string' || change.text.includes('\0')) throw new Error('Invalid edit batch.');
    const size = Buffer.byteLength(change.text);
    bytes += size;
    if (size > maxFileBytes || bytes > 16 * 1024 * 1024) throw new Error('The edit batch exceeds the draft size limit.');
    files.add(key);
    try {
      await verifyRevision(project, change.path, change.revision);
    } catch {
      throw new Error('The original changed or is unavailable. Refresh the preview for ' + change.path);
    }
  }
  currentWorkspace(id);
  await drafts.setMany(project.root, changes);
});
handle('save-copy', (id, file, text) => saveRecoveryCopy(currentWorkspace(id), file, text));
handle('draft', (id, file, text, revision) => {
  const project = currentWorkspace(id);
  if (path.relative(project.root, workspacePath(project, file)) === '') throw new Error('Choose a regular file.');
  return drafts.set(project.root, file, text, revision);
});

function authorizedWorkspace(id, runId, token) {
  const project = currentWorkspace(id);
  if (runGrant?.id !== id || runGrant.runId !== runId || runGrant.token !== token) throw new Error('Authorize workspace execution first.');
  runGrant = undefined;
  if (changingWorkspace || closePending || allowClose) throw new Error('The workspace is changing.');
  return project;
}

handle('start', (id, file, revision, runId, token) => {
  const project = authorizedWorkspace(id, runId, token);
  return sessions.start(id, runId, token, (publish, isStopping) => startNodeRun(project, file, revision, publish, isStopping));
});

handle('test', (id, retry, runId, token, goal) => {
  const project = authorizedWorkspace(id, runId, token);
  const current = workstream;
  return sessions.start(project.id, runId, token, (publish, isStopping) => current.start(retry === true, goal, publish, isStopping));
});
handle('test-evidence', (id, evidenceId) => {
  currentWorkspace(id);
  return workstream.recheck(evidenceId);
});

handle('stop', (id, runId, sessionId) => {
  currentWorkspace(id);
  if (runGrant?.id === id && runGrant.runId === runId && runGrant.token === sessionId) {
    runGrant = undefined;
    return true;
  }
  return sessions.stop(id, runId, sessionId);
});
handle('run-output', (id, runId, sessionId, cursor) => {
  currentWorkspace(id);
  return sessions.output(id, runId, sessionId, cursor);
});

ipcMain.on('cevra:ready', event => {
  if (isWorkbench(event)) rendererReady = true;
});

handle('close-ready', async (hasDrafts, backupFailed) => {
  await preferences.getTheme();
  if (!closePending) return;
  const closing = window;
  const stay = backupFailed ? dialog.showMessageBoxSync(window, {
    type: 'error',
    message: 'Some draft backups could not be updated.',
    detail: 'Only completed backups can be recovered.',
    buttons: ['Keep editing', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
  }) === 0 : hasDrafts && dialog.showMessageBoxSync(window, {
    type: 'question',
    message: 'Quit CEVRA and keep your drafts?',
    detail: 'CEVRA will reopen the drafts next time.',
    buttons: ['Keep editing', 'Quit and keep drafts'],
    defaultId: 0,
    cancelId: 0,
  }) === 0;
  if (stay) {
    closePending = false;
    window.webContents.send('cevra:close-canceled');
  } else {
    runGrant = undefined;
    await sessions.cancel();
    if (!closePending || window !== closing) return;
    closePending = false;
    allowClose = true;
    setImmediate(() => closing.close());
  }
});

async function launch() {
  nativeTheme.themeSource = await preferences.getTheme();
  const previous = window;
  const bounds = previous?.getBounds();
  const maximized = previous?.isMaximized();
  Menu.setApplicationMenu(null);
  const workbench = new BrowserWindow({
    width: 1380,
    height: 900,
    ...bounds,
    minWidth: 740,
    minHeight: 560,
    ...windowAppearance(colorMode()),
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, '..', 'cevra-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window = workbench;
  workbench.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  workbench.webContents.on('will-navigate', event => event.preventDefault());
  workbench.webContents.on('will-attach-webview', event => event.preventDefault());
  workbench.webContents.on('render-process-gone', () => {
    if (window !== workbench) return;
    rendererReady = false;
    runGrant = undefined;
    closePending = false;
    activeSearch?.controller.abort();
    syntax.stop();
    formatter.stop();
    semantics.stop();
    void sessions.cancel();
    const now = Date.now();
    const repeated = now - lastRendererCrash < 2_000;
    lastRendererCrash = now;
    setImmediate(() => {
      if (window !== workbench || workbench.isDestroyed() || allowClose) return;
      if (repeated) workbench.close();
      else launch().catch(error => {
        console.error(error);
        app.exit(1);
      });
    });
  });
  workbench.on('close', event => {
    if (allowClose || !rendererReady) {
      activeSearch?.controller.abort();
      void sessions.cancel();
      return;
    }
    event.preventDefault();
    if (!closePending) {
      closePending = true;
      workbench.webContents.send('cevra:before-close');
    }
  });
  workbench.on('closed', () => { if (window === workbench) window = undefined; });
  if (maximized) workbench.maximize();
  previous?.destroy();
  await workbench.loadFile(page);
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(launch).catch(error => {
    console.error(error);
    app.exit(1);
  });
} else {
  app.quit();
}

app.on('window-all-closed', () => app.quit());
app.on('will-quit', tests.dispose);
app.on('will-quit', syntax.stop);
app.on('will-quit', formatter.stop);
app.on('will-quit', semantics.stop);
