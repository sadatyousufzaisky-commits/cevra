const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createWorkspace, listFolder, readSource, saveSource, saveRecoveryCopy, workspacePath } = require('./workspace.cjs');
const { startNodeRun } = require('./runner.cjs');
const { createTestSession } = require('./project-tests.cjs');
const { createDraftStore } = require('./drafts.cjs');
const { searchProject } = require('./project-search.cjs');
const { createSyntaxService } = require('./syntax-service.cjs');
const { createFormatService } = require('./format-service.cjs');
const { createSemanticService } = require('./semantic-service.cjs');

app.setName('CEVRA');

const page = path.join(__dirname, 'index.html');
const pageURL = pathToFileURL(page).href;
const tests = createTestSession(app.getPath('temp'));
const drafts = createDraftStore(path.join(app.getPath('userData'), 'drafts'));
const syntax = createSyntaxService();
const formatter = createFormatService();
const semantics = createSemanticService();
let window;
let workspace;
let activeRun;
let activeSearch;
let rendererReady = false;
let closePending = false;
let allowClose = false;
let lastRendererCrash = 0;

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

async function openWorkspace(folder, { entry, discard, recovering = false } = {}) {
  if (activeRun && !recovering) throw new Error('Stop the current run before opening another project.');
  const next = await createWorkspace(folder);
  const files = await listFolder(next);
  if (discard && workspace) await drafts.clear(workspace.root);
  const { entries, unreadable } = await readDrafts();
  const recovered = entries.filter(draft => draft.root === next.root);
  activeSearch?.controller.abort();
  syntax.stop();
  formatter.stop();
  semantics.stop();
  workspace = next;
  return {
    id: next.id, root: next.root, name: next.name, files, entry, recovered, unreadable,
    caseInsensitivePaths: process.platform === 'win32',
  };
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

handle('choose-folder', async discard => {
  const choice = await dialog.showOpenDialog(window, {
    title: 'Open a CEVRA workspace',
    properties: ['openDirectory'],
  });
  if (choice.canceled) return null;
  return openWorkspace(choice.filePaths[0], { discard: discard === true });
});

handle('open-example', async discard => {
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
handle('save-copy', (id, file, text) => saveRecoveryCopy(currentWorkspace(id), file, text));
handle('draft', (id, file, text, revision) => {
  const project = currentWorkspace(id);
  if (path.relative(project.root, workspacePath(project, file)) === '') throw new Error('Choose a regular file.');
  return drafts.set(project.root, file, text, revision);
});

async function execute(runId, start) {
  if (activeRun) throw new Error('A program is already running.');
  const run = { stopRequested: false };
  activeRun = run;
  try {
    run.controller = await start(event => {
      if (activeRun === run && event.type === 'exit') activeRun = undefined;
      if (rendererReady && window && !window.isDestroyed()) {
        window.webContents.send('cevra:run-event', { ...event, runId });
      }
    });
    if (run.stopRequested) run.controller.stop();
  } catch (error) {
    activeRun = undefined;
    throw error;
  }
}

handle('start', (id, file, revision, runId) =>
  execute(runId, publish => startNodeRun(currentWorkspace(id), file, revision, publish)));

handle('test', (id, retry, runId) =>
  execute(runId, publish => tests.start(currentWorkspace(id), retry === true, publish)));

function stopRun() {
  if (!activeRun) return;
  activeRun.stopRequested = true;
  activeRun.controller?.stop();
}

handle('stop', stopRun);

ipcMain.on('cevra:ready', event => {
  if (isWorkbench(event)) rendererReady = true;
});

handle('close-ready', (hasDrafts, backupFailed) => {
  if (!closePending) return;
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
  closePending = false;
  if (stay) {
    window.webContents.send('cevra:close-canceled');
  } else {
    allowClose = true;
    setImmediate(() => window?.close());
  }
});

async function launch() {
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
    backgroundColor: '#101417',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#14191d', symbolColor: '#e3ebea', height: 51 },
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
    closePending = false;
    activeSearch?.controller.abort();
    syntax.stop();
    formatter.stop();
    semantics.stop();
    stopRun();
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
      stopRun();
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
