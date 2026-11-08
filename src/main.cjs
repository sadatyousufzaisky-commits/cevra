const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createWorkspace, listFolder, readSource, saveSource } = require('./workspace.cjs');
const { startNodeRun } = require('./runner.cjs');
const { createTestSession } = require('./project-tests.cjs');

const page = path.join(__dirname, 'index.html');
const pageURL = pathToFileURL(page).href;
const tests = createTestSession(app.getPath('temp'));
let window;
let workspace;
let activeRun;
let dirty = false;

app.setName('CEVRA');

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

async function openWorkspace(folder, entry) {
  if (activeRun) throw new Error('Stop the current run before opening another project.');
  const next = await createWorkspace(folder);
  const files = await listFolder(next);
  workspace = next;
  return { ...next, files, entry };
}

handle('choose-folder', async () => {
  const choice = await dialog.showOpenDialog(window, {
    title: 'Open a CEVRA workspace',
    properties: ['openDirectory'],
  });
  if (choice.canceled) return null;
  return openWorkspace(choice.filePaths[0]);
});

handle('open-example', async () => {
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
  return openWorkspace(folder, 'hello.js');
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
handle('save', (id, file, text, revision) => saveSource(currentWorkspace(id), file, text, revision));

async function execute(runId, start) {
  if (activeRun) throw new Error('A program is already running.');
  const run = { stopRequested: false };
  activeRun = run;
  try {
    run.controller = await start(event => {
      if (activeRun === run && event.type === 'exit') activeRun = undefined;
      if (window && !window.isDestroyed()) {
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

ipcMain.on('cevra:dirty', (event, value) => {
  if (isWorkbench(event)) dirty = value === true;
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1380,
    height: 900,
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
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => {
    if (dirty && dialog.showMessageBoxSync(window, {
      type: 'warning',
      message: 'Quit CEVRA and discard unsaved changes?',
      buttons: ['Keep editing', 'Quit'],
      defaultId: 0,
      cancelId: 0,
    }) === 0) {
      event.preventDefault();
      return;
    }
    stopRun();
  });
  window.on('closed', () => { window = undefined; });
  return window.loadFile(page);
}).catch(error => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', tests.dispose);
