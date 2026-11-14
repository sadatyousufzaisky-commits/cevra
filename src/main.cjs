const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme } = require('electron');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { productName, appId, icon } = require('./identity.cjs');
const { profileLocation } = require('./profile-location.cjs');
const { createWorkspace, listFolder, maxFileBytes, readSource, saveSource, saveRecoveryCopy,
  resolveEntry, verifyRevision, workspacePath } = require('./workspace.cjs');
const { sourceFileKey } = require('./source-files.cjs');
const { startSourceRun } = require('./runner.cjs');
const { createTestSession } = require('./project-tests.cjs');
const { createDraftStore } = require('./drafts.cjs');
const { searchProject } = require('./project-search.cjs');
const { createSyntaxService } = require('./syntax-service.cjs');
const { createFormatService } = require('./format-service.cjs');
const { createSemanticService } = require('./semantic-service.cjs');
const { createPreferences } = require('./preferences.cjs');
const { createExtensionRegistry } = require('./extensions/registry.cjs');
const { createExtensionManager } = require('./extensions/manager.cjs');
const { InspectionError } = require('./extensions/inspection-error.cjs');
const { createExtensionAudit } = require('./extensions/audit.cjs');
const { createCapabilityBroker } = require('./extensions/broker.cjs');
const { startExtensionHost, supportedRuntime } = require('./extensions/runtime.cjs');
const { canonicalFile, digestPattern, exactKeys, permissionLabel } = require('./extensions/capabilities.cjs');
const { createFlightpathStore } = require('./continuum/flightpath.cjs');
const { createChangeLens } = require('./continuum/change-lens.cjs');
const { createTestWorkstream, workstreamGoal } = require('./continuum/workstream.cjs');
const { readTaskCatalog } = require('./continuum/task-catalog.cjs');
const { createTaskRunner } = require('./continuum/task-runner.cjs');
const { createRecipeFile, recipeCatalog, recipeFile, requireRecipe, resolveRecipe, upgradeRecipes } = require('./continuum/recipes.cjs');
const { startRecipe } = require('./continuum/recipe-runner.cjs');
const { createExecutionSessions } = require('./execution/sessions.cjs');
const { startDebugger } = require('./execution/debugger.cjs');
const { createPythonProfiles } = require('./execution/python-profiles.cjs');
const { createTerminalSessions, terminalProfile, validateSize, maxTerminalInput } = require('./execution/terminal-sessions.cjs');

app.setName(productName);
if (process.platform === 'win32') app.setAppUserModelId(appId);
const selectedProfile = profileLocation(app.getPath('appData'), app.commandLine.hasSwitch('user-data-dir') ?
  path.resolve(app.commandLine.getSwitchValue('user-data-dir') || app.getPath('userData')) : undefined);
mkdirSync(selectedProfile.directory, { recursive: true });
app.setPath('userData', selectedProfile.directory);

const page = path.join(__dirname, 'index.html');
const pageURL = pathToFileURL(page).href;
const tests = createTestSession(app.getPath('temp'));
const drafts = createDraftStore(path.join(app.getPath('userData'), 'drafts'));
const preferences = createPreferences(app.getPath('userData'));
const safeStart = app.commandLine.hasSwitch('disable-extensions');
const liveIntelligence = app.commandLine.hasSwitch('enable-intelligence');
const intelligencePatches = liveIntelligence ?
  require('./intelligence/patch-broker.cjs').createPatchBroker({
    current: intelligenceWorkspace, readEditor: readPatchEditor, changed: showIntelligenceProposal,
  }) : undefined;
const intelligenceMock = liveIntelligence || app.commandLine.hasSwitch('enable-intelligence-mock') ?
  require('./intelligence/mock-window.cjs').createIntelligenceMockWindow(app.getPath('userData'), {
    live: liveIntelligence, getWorkspace: intelligenceWorkspace, readEditor: readContextEditor, openSource: openIntelligenceSource,
    getPreferences: () => preferences.getIntelligence(), setPreferences: values => preferences.setIntelligence(values),
    getModels: () => preferences.getIntelligenceModels(), setModels: values => preferences.setIntelligenceModels(values),
    patches: intelligencePatches, runAgentTests, recheckBaseline: (project, id) =>
      intelligenceWorkspace() === project ? workstream.recheck(id) : undefined,
  }) : undefined;
const extensions = createExtensionRegistry(app.getPath('userData'));
const flightpathStore = createFlightpathStore(path.join(app.getPath('userData'), 'flightpath'));
const syntax = createSyntaxService();
const formatter = createFormatService();
const semantics = createSemanticService();
const terminals = createTerminalSessions();
let window;
let workspace;
let workstream;
let taskRunner;
let pythonProfiles;
let flightpath;
let changeLens;
let gitWrite;
let changingWorkspace = false;
let runGrant;
let trustEpoch = 0;
let authorizingRun = false;
let intelligenceTest;
let intelligenceRunSequence = 0;
let activeSearch;
let rendererReady = false;
let closePending = false;
let allowClose = false;
let restartExtensions;
let lastRendererCrash = 0;
let authorizingExtension = false;
const editorSnapshots = new Map();
const extensionAudit = createExtensionAudit(app.getPath('userData'));
const extensionBroker = createCapabilityBroker({
  registry: extensions, audit: extensionAudit,
  getWorkspace: () => changingWorkspace || closePending || allowClose || !rendererReady ? undefined : workspace,
  isTrusted: project => preferences.isTrusted(project), safeStart, supported: supportedRuntime(),
  startHost: startExtensionHost, editorSnapshot: readExtensionEditor,
  consent: async ({ id, digest, manifest, project }) => {
    const descriptions = manifest.permissions.map(permission => {
      const files = permission.files ? '\n  ' + permission.files.join('\n  ') : '';
      return permissionLabel(permission) + files;
    }).join('\n\n');
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning', title: 'Extension permissions',
      message: 'Allow ' + manifest.displayName + ' in this workspace?',
      detail: id + ' · Publisher unverified\nSHA-256 ' + digest + '\n\n' + project.root + '\n\n' + descriptions +
        '\n\nAccess lasts until revocation, workspace change, or exit. Proposed edits require a separate preview and acceptance.',
      buttons: ['Cancel', 'Allow for This Session'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return response === 1;
  },
  changed: notifyExtensionRuntime,
});
const extensionManager = createExtensionManager({
  registry: extensions, broker: extensionBroker,
  owner: () => rendererReady && !changingWorkspace && !closePending && !allowClose && !authorizingExtension &&
    window && !window.isDestroyed() ? window : undefined,
  async choosePackage(owner) {
    const selection = await dialog.showOpenDialog(owner, {
      title: 'Choose an extension package', properties: ['openFile'], filters: [{ name: 'Extension ZIP packages', extensions: ['zip'] }],
    });
    return selection.canceled ? undefined : selection.filePaths[0];
  },
  async confirm(owner, entry, action) {
    const prompts = {
      quarantine: ['Quarantine', 'The extension will be disabled and require review before it can be enabled again.'],
      'clear-quarantine': ['Clear Quarantine', 'The extension will stay disabled until you enable it.'],
      restore: ['Restore Previous Version', `Restore version ${entry.rollback?.version} as a disabled extension.\nPrevious SHA-256 ${entry.rollback?.sha256}`],
      uninstall: ['Uninstall', 'This removes the installed package and its retained version from VOKRI Code.'],
    };
    const [label, explanation] = prompts[action];
    const { response } = await dialog.showMessageBox(owner, {
      type: 'warning', title: 'Extension Manager', message: `${label} ${entry.displayName ?? entry.id}?`,
      detail: `${entry.id} · ${entry.version}\nSHA-256 ${entry.sha256}\n\n${explanation}`,
      buttons: ['Cancel', label], defaultId: 0, cancelId: 0, noLink: true,
    });
    return response === 1;
  },
});
function notifyExtensionRuntime() {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('cevra:extension-runtime-changed');
}
app.once('will-quit', extensions.onChange((id, change) => {
  if (change !== 'pin' && !safeStart && window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('cevra:extension-contributions-changed', id);
  }
  notifyExtensionRuntime();
}));
const sessions = createExecutionSessions(event => {
  if (intelligenceTest?.id === event.runId && intelligenceTest.token === event.sessionId &&
      intelligenceTest.project.id === event.workspaceId) {
    if (event.type === 'exit') intelligenceTest.finished.resolve(event);
    return;
  }
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
    backgroundColor: dark ? '#11111c' : '#fafaff',
    titleBarOverlay: { color: dark ? '#171724' : '#eeeef9', symbolColor: dark ? '#f0f3fb' : '#22213a', height: 51 },
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

function intelligenceWorkspace() {
  return changingWorkspace || closePending || allowClose || !rendererReady ? undefined : workspace;
}

function readExtensionEditor(project, file, signal, allowedFiles) {
  return requestEditor(project, 'extension-editor-snapshot', { path: file, allowedFiles }, signal);
}

function readContextEditor(project, file, signal) {
  return requestEditor(project, 'intelligence-editor-snapshot', { path: file }, signal);
}

function readPatchEditor(project, file, signal) {
  return requestEditor(project, 'intelligence-patch-snapshot', { path: file }, signal);
}

function showIntelligenceProposal(proposal) {
  if (!proposal) intelligenceMock?.proposalRetired();
  if (rendererReady && window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('cevra:intelligence-proposal-changed', proposal);
    if (proposal) window.flashFrame(true);
  }
}

function showAgentTest(active) {
  if (rendererReady && window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('cevra:intelligence-test-active', active);
  }
}

async function runAgentTests(project, { verifying, signal, recheck }) {
  if (intelligenceWorkspace() !== project || sessions.busy || intelligenceTest || authorizingRun || runGrant) {
    throw new Error('Wait for the current workspace action.');
  }
  signal.throwIfAborted();
  const attempt = { id: ++intelligenceRunSequence, token: randomUUID(), project, finished: Promise.withResolvers() };
  intelligenceTest = attempt;
  const stop = () => sessions.stop(project.id, attempt.id, attempt.token);
  signal.addEventListener('abort', stop, { once: true });
  const timeout = AbortSignal.timeout(3 * 60_000);
  timeout.addEventListener('abort', stop, { once: true });
  const execution = AbortSignal.any([signal, timeout]);
  showAgentTest(true);
  try {
    const approved = await authorizeExecution(project, {
      title: verifying ? 'Verify Intelligence change' : 'Run baseline tests',
      message: verifying ? 'Run project tests to verify the approved change?' : 'Run the project tests for this Intelligence task?',
      detail: 'VOKRI Code will run the project’s Node.js tests with your Windows user permissions. Tests read the files on disk.',
      confirmTrusted: true, runLabel: 'Run Tests', onceOnly: true, signal: execution,
    }, () => true);
    if (!approved) return null;
    execution.throwIfAborted();
    if (sessions.busy || intelligenceWorkspace() !== project || gitWrite) throw new Error('The workspace is busy.');
    const { entries, unreadable } = await readDrafts();
    if (unreadable || entries.some(draft => draft.root === project.root)) {
      throw new Error('Save or discard workspace drafts before running the test step.');
    }
    await recheck?.();
    execution.throwIfAborted();
    if (sessions.busy || intelligenceWorkspace() !== project || gitWrite) throw new Error('The workspace is busy.');
    const runner = workstream;
    await sessions.start(project.id, attempt.id, attempt.token, (publish, isStopping) =>
      runner.start(false, verifying ? 'Intelligence verification' : 'Intelligence baseline', publish,
        () => execution.aborted || isStopping()));
    return await attempt.finished.promise;
  } finally {
    signal.removeEventListener('abort', stop);
    timeout.removeEventListener('abort', stop);
    if (intelligenceTest === attempt) {
      intelligenceTest = undefined;
      showAgentTest(false);
    }
  }
}

async function openIntelligenceSource(project, source, signal) {
  if (intelligenceWorkspace() !== project) throw new Error('This workspace has closed.');
  const opened = await requestEditor(project, 'intelligence-source-location', { source }, signal);
  if (!opened || intelligenceWorkspace() !== project) throw new Error('This source is no longer current.');
  if (window && !window.isDestroyed()) window.focus();
}

function requestEditor(project, channel, payload, signal) {
  if (!rendererReady || !window || window.isDestroyed() || signal?.aborted || editorSnapshots.size >= 8) {
    return Promise.reject(new Error('The editor is unavailable.'));
  }
  const requestId = randomUUID();
  const owner = window.webContents;
  return new Promise((resolve, reject) => {
    function finish(error, value) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      editorSnapshots.delete(requestId);
      if (error) reject(error);
      else resolve(value);
    }
    const aborted = () => finish(new Error('The editor request expired.'));
    const timer = setTimeout(aborted, 3000);
    signal?.addEventListener('abort', aborted, { once: true });
    editorSnapshots.set(requestId, { project, channel, file: payload.path, allowedFiles: payload.allowedFiles, owner, finish });
    try { owner.send('cevra:' + channel, { requestId, workspaceId: project.id, ...payload }); }
    catch (error) { finish(error); }
  });
}

function finishEditorSnapshot(channel, requestId, snapshot) {
  const request = editorSnapshots.get(requestId);
  if (!request || request.channel !== channel || request.owner !== window?.webContents || request.project !== workspace) return;
  if (snapshot === null) return request.finish(undefined, null);
  const patch = channel === 'intelligence-patch-snapshot';
  if (patch && snapshot?.blocked === true) return request.finish(new Error('The editor buffer is unavailable.'));
  const fields = ['path', 'text', 'baseRevision', 'documentId', 'version', 'selection'];
  if (patch) fields.push('lineEnding');
  if (!exactKeys(snapshot, fields) || (patch && !['\n', '\r\n', '\r'].includes(snapshot.lineEnding)) ||
      !canonicalFile(snapshot.path) || (request.file && sourceFileKey(snapshot.path) !== sourceFileKey(request.file)) ||
      (request.allowedFiles && !request.allowedFiles.some(file => sourceFileKey(file) === sourceFileKey(snapshot.path))) ||
      typeof snapshot.text !== 'string' || !snapshot.text.isWellFormed() || Buffer.byteLength(snapshot.text) > 512 * 1024 ||
      typeof snapshot.baseRevision !== 'string' || !digestPattern.test(snapshot.baseRevision) ||
      !Number.isSafeInteger(snapshot.documentId) || snapshot.documentId < 1 || !Number.isSafeInteger(snapshot.version) || snapshot.version < 0 ||
      !exactKeys(snapshot.selection, ['from', 'to']) || !Number.isInteger(snapshot.selection.from) || !Number.isInteger(snapshot.selection.to)) {
    return request.finish(new Error('Invalid editor snapshot.'));
  }
  request.finish(undefined, snapshot);
}

for (const channel of ['extension-editor-snapshot', 'intelligence-editor-snapshot', 'intelligence-patch-snapshot']) {
  handle(channel, (requestId, snapshot) => finishEditorSnapshot(channel, requestId, snapshot));
}
handle('intelligence-source-location', (requestId, opened) => {
  const request = editorSnapshots.get(requestId);
  if (request?.channel === 'intelligence-source-location' && request.owner === window?.webContents &&
      request.project === intelligenceWorkspace()) request.finish(undefined, opened === true);
});

async function readDrafts() {
  try {
    return await drafts.list();
  } catch {
    return { entries: [], unreadable: true };
  }
}

function ensureWorkspaceAvailable(recovering = false) {
  if (changingWorkspace) throw new Error('A workspace is already opening.');
  if (sessions.busy && !intelligenceTest && (!recovering || rendererReady)) throw new Error('Stop the current run before opening another project.');
  if (gitWrite && !recovering) throw new Error('Wait for the Git action to finish.');
}

async function openWorkspace(folder, { entry, discard, recovering = false } = {}) {
  ensureWorkspaceAvailable(recovering);
  changingWorkspace = true;
  runGrant = undefined;
  try {
    if (recovering) await Promise.all([sessions.cancel(), gitWrite?.catch(() => {})]);
    const next = await createWorkspace(folder);
    const files = await listFolder(next);
    const settings = await preferences.getEditor(next);
    if (!recovering && terminals.liveCount) {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning', title: 'Switch workspace',
        message: 'Close the active terminals and switch workspaces?',
        detail: 'Commands still running in those terminals will stop.',
        buttons: ['Stay Here', 'Close Terminals and Switch'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (response !== 1) return null;
    }
    if (discard && workspace) await drafts.clear(workspace.root);
    const { entries, unreadable } = await readDrafts();
    const recovered = entries.filter(draft => draft.root === next.root);
    intelligenceMock?.close();
    if (intelligenceTest) await sessions.cancel();
    await terminals.closeAll();
    await extensionBroker.suspend().catch(() => {});
    activeSearch?.controller.abort();
    syntax.stop();
    formatter.stop();
    semantics.stop();
    workspace = next;
    flightpath = flightpathStore.forWorkspace(next);
    workstream = createTestWorkstream(next, tests.start, flightpath);
    changeLens = createChangeLens(next, flightpath, workstream.latestFull);
    taskRunner = createTaskRunner(next, flightpath);
    pythonProfiles = createPythonProfiles(next);
    return {
      id: next.id, root: next.root, name: next.name, files, entry, recovered, unreadable, settings,
      caseInsensitivePaths: process.platform === 'win32',
      terminalLimit: process.platform === 'win32' ? terminals.maxSessions : 0,
    };
  } finally {
    changingWorkspace = false;
  }
}

handle('initial', async () => {
  const { entries, unreadable } = await readDrafts();
  const features = intelligenceMock ? { intelligenceMock: true, intelligenceContext: liveIntelligence } : {};
  const roots = new Set([workspace?.root, ...entries.map(draft => draft.root)]);
  let unavailable = false;
  for (const root of roots) {
    if (!root) continue;
    try {
      return { ...features, project: await openWorkspace(root, { recovering: true }), unavailable };
    } catch {
      unavailable = true;
    }
  }
  return { ...features, unavailable, unreadable };
});

handle('open-intelligence-mock', input => {
  if (!intelligenceMock) throw new Error('The Intelligence mock is disabled.');
  if (!rendererReady || changingWorkspace || closePending || allowClose || !window || window.isDestroyed()) {
    throw new Error('Wait for the workbench to become available.');
  }
  return intelligenceMock.open(window, input);
});
handle('intelligence-proposal', (id, proposalId) => intelligencePatches?.preview(currentWorkspace(id), proposalId));
handle('dismiss-intelligence-proposal', (id, proposalId) => intelligencePatches?.dismiss(currentWorkspace(id), proposalId));

handle('appearance', () => ({ theme: nativeTheme.themeSource, mode: colorMode() }));
handle('set-theme', async choice => {
  const theme = await preferences.setTheme(choice);
  nativeTheme.themeSource = theme;
  syncWindowAppearance();
  return { theme, mode: colorMode() };
});
handle('extension-contributions', async () => {
  if (safeStart) return { packages: [], palette: null };
  const [packages, palette] = await Promise.all([extensions.contributions(), preferences.getExtensionPalette()]);
  return { packages, palette };
});
handle('set-extension-palette', async key => {
  if (safeStart || typeof key !== 'string' ||
      !(await extensions.contributions()).some(extension => extension.palettes.some(palette => palette.key === key))) {
    throw new Error('This extension palette is unavailable.');
  }
  await preferences.setExtensionPalette(key);
});
handle('extension-runtime', async (id, includeCatalog = true) => {
  if (id !== undefined) currentWorkspace(id);
  let catalog;
  let catalogError;
  if (includeCatalog === true) {
    try { catalog = await extensions.list(); }
    catch (error) {
      catalog = [];
      catalogError = error instanceof InspectionError ? error.message : 'The extension registry could not be read.';
    }
  }
  if (id !== undefined) currentWorkspace(id);
  const runtime = extensionBroker.snapshot();
  return { ...runtime, safeStart, catalog, catalogError, sessions: id === undefined ? [] : runtime.sessions };
});
handle('select-extension-package', () => extensionManager.select());
handle('inspect-installed-extension', (id, digest) => extensionManager.inspect(id, digest));
handle('install-extension', (token, approveDowngrade) => extensionManager.install(token, approveDowngrade));
handle('discard-extension-review', token => extensionManager.discard(token));
handle('change-extension', (id, digest, action) => extensionManager.change(id, digest, action));
handle('restart-extensions', disabled => {
  if (typeof disabled !== 'boolean' || disabled === safeStart || !rendererReady || changingWorkspace || closePending ||
      allowClose || authorizingExtension || extensionManager.busy || restartExtensions !== undefined) {
    throw new Error('Extension restart is unavailable.');
  }
  restartExtensions = disabled;
  window.close();
});
handle('activate-extension', async (id, extensionId, digest) => {
  const project = currentWorkspace(id);
  if (authorizingExtension || extensionManager.busy || changingWorkspace || closePending || allowClose || !rendererReady || safeStart || !supportedRuntime()) {
    throw new Error('Extension activation is unavailable.');
  }
  authorizingExtension = true;
  const owner = window.webContents;
  const activationEpoch = trustEpoch;
  function checkOwner() {
    currentWorkspace(id);
    if (changingWorkspace || closePending || allowClose || !rendererReady || owner !== window?.webContents || activationEpoch !== trustEpoch) {
      throw new Error('The extension activation request expired.');
    }
  }
  try {
    await extensions.executable(extensionId, digest);
    checkOwner();
    if (!await preferences.isTrusted(project)) {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning', title: 'Workspace trust', message: 'Trust this workspace to activate extensions?',
        detail: project.root + '\n\nWorkspace execution will be trusted. Each extension also requires its own permission review.',
        buttons: ['Cancel', 'Trust Workspace'], defaultId: 0, cancelId: 0, noLink: true,
      });
      checkOwner();
      if (response !== 1) return false;
      await preferences.setTrusted(project, true);
    }
    checkOwner();
    return await extensionBroker.activate(extensionId, digest);
  } finally { authorizingExtension = false; }
});
handle('revoke-extension', (id, extensionId) => { currentWorkspace(id); return extensionBroker.revoke(extensionId); });
handle('extension-command', (id, extensionId, commandId) => { currentWorkspace(id); return extensionBroker.invoke(extensionId, commandId); });
handle('extension-proposal', (id, extensionId, proposalId) => { currentWorkspace(id); return extensionBroker.proposal(extensionId, proposalId); });
ipcMain.on('cevra:extension-document-changed', (event, id, file) => {
  if (!isWorkbench(event) || workspace?.id !== id || typeof file !== 'string') return;
  extensionBroker.documentChanged(id, file.replaceAll('\\', '/'));
  intelligenceMock?.documentChanged(workspace, file);
});
ipcMain.on('cevra:intelligence-document-closed', (event, id, file) => {
  if (isWorkbench(event) && workspace?.id === id && typeof file === 'string') intelligenceMock?.documentChanged(workspace, file);
});
handle('editor-settings', id => preferences.getEditor(id ? currentWorkspace(id) : undefined));
handle('set-editor-settings', (id, scope, values) =>
  preferences.setEditor(id ? currentWorkspace(id) : undefined, scope, values));
handle('workspace-trust', id => preferences.isTrusted(currentWorkspace(id)));
handle('revoke-trust', async id => {
  const project = currentWorkspace(id);
  trustEpoch++;
  runGrant = undefined;
  intelligenceMock?.close();
  void sessions.cancel();
  await Promise.all([extensionBroker.suspend().catch(() => {}), preferences.setTrusted(project, false)]);
});

async function authorizeExecution(project, prompt, start) {
  if (authorizingRun) throw new Error('An execution request is already active.');
  if (changingWorkspace || closePending || allowClose || gitWrite || (intelligenceTest && !prompt.onceOnly)) {
    throw new Error('The workspace is changing or running Intelligence tests.');
  }
  const owner = window.webContents;
  const epoch = trustEpoch;
  function checkConsent() {
    prompt.signal?.throwIfAborted();
    currentWorkspace(project.id);
    if (changingWorkspace || closePending || allowClose || gitWrite || window?.webContents !== owner ||
        !rendererReady || trustEpoch !== epoch) throw new Error('The execution request expired.');
  }
  authorizingRun = true;
  try {
    await resolveEntry(project, '');
    const trusted = await preferences.isTrusted(project);
    checkConsent();
    let trust = false;
    if (!trusted || prompt.confirmTrusted) {
      const { response } = await dialog.showMessageBox(window, {
        type: trusted ? 'question' : 'warning',
        title: prompt.title ?? 'Workspace execution',
        message: prompt.message,
        detail: project.root + '\n\n' + prompt.detail,
        buttons: prompt.onceOnly ? ['Cancel', prompt.runLabel] :
          trusted ? ['Cancel', prompt.runLabel ?? 'Run Recipe'] : ['Cancel', 'Run Once', 'Trust Workspace'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal: prompt.signal,
      });
      trust = !prompt.onceOnly && !trusted && response === 2;
      if (response !== 1 && !trust) return null;
      checkConsent();
      await prompt.recheck?.();
    }
    const root = await resolveEntry(project, '');
    checkConsent();
    if (trust) await preferences.setTrusted(project, true);
    checkConsent();
    return start(root);
  } finally {
    authorizingRun = false;
  }
}

handle('authorize-run', (id, runId) => {
  const project = currentWorkspace(id);
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Invalid execution request.');
  if (authorizingRun || sessions.busy || intelligenceTest) throw new Error('An execution request is already active.');
  runGrant = undefined;
  return authorizeExecution(project, {
    message: 'Allow VOKRI Code to run code from this workspace?',
    detail: 'Code and tests run with your Windows user permissions.',
  }, () => {
    const token = randomUUID();
    runGrant = { id, runId, token };
    return token;
  });
});

handle('terminal-new', (id, profile, columns, rows) => {
  const project = currentWorkspace(id);
  if (process.platform !== 'win32') throw new Error('The live terminal requires Windows.');
  const { name } = terminalProfile(profile);
  validateSize(columns, rows);
  return authorizeExecution(project, {
    message: 'Open ' + name + ' in this workspace?',
    detail: 'Terminal commands run with your Windows user permissions.',
  }, root => terminals.start(id, root, profile, columns, rows));
});
handle('terminal-read', (id, sessionId) => terminals.read(currentWorkspace(id).id, sessionId));
handle('terminal-write', (id, sessionId, text) => terminals.write(currentWorkspace(id).id, sessionId, text));
handle('terminal-resize', (id, sessionId, columns, rows) => terminals.resize(currentWorkspace(id).id, sessionId, columns, rows));
handle('terminal-close', (id, sessionId) => terminals.close(currentWorkspace(id).id, sessionId));
handle('terminal-copy', (id, sessionId, text) => {
  terminals.assertSession(currentWorkspace(id).id, sessionId);
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) throw new Error('The selection is too large to copy.');
  return clipboard.writeText(text);
});
handle('terminal-paste', async (id, sessionId) => {
  terminals.assertSession(currentWorkspace(id).id, sessionId);
  const text = await clipboard.readText();
  terminals.assertSession(currentWorkspace(id).id, sessionId);
  if (Buffer.byteLength(text) > maxTerminalInput) throw new Error('Clipboard text exceeds the 16 KiB terminal paste limit.');
  return text;
});

handle('choose-folder', async discard => {
  ensureWorkspaceAvailable();
  const choice = await dialog.showOpenDialog(window, {
    title: 'Open a VOKRI Code workspace',
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
handle('stage-edits', async (id, changes, authority) => {
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
  if (intelligencePatches && exactKeys(authority, ['intelligenceProposalId', 'review'])) {
    await intelligencePatches.commit(project, authority.intelligenceProposalId, authority.review, changes,
      beforeCommit => drafts.setMany(project.root, changes, { beforeCommit }),
      () => intelligenceMock?.patchApplied(project, changes));
  } else if (authority !== undefined) {
    if (!exactKeys(authority, ['extensionId', 'proposalId'])) throw new Error('Invalid extension proposal.');
    await extensionBroker.commitProposal(authority.extensionId, authority.proposalId, changes,
      beforeCommit => drafts.setMany(project.root, changes, { beforeCommit }));
  } else await drafts.setMany(project.root, changes);
});
handle('save-copy', (id, file, text) => saveRecoveryCopy(currentWorkspace(id), file, text));
handle('draft', (id, file, text, revision) => {
  const project = currentWorkspace(id);
  if (path.relative(project.root, workspacePath(project, file)) === '') throw new Error('Choose a regular file.');
  return drafts.set(project.root, file, text, revision);
});

function authorizedWorkspace(id, runId, token, kind = 'run') {
  const project = currentWorkspace(id);
  if (runGrant?.id !== id || runGrant.runId !== runId || runGrant.token !== token ||
      (runGrant.kind ?? 'run') !== kind) throw new Error('Authorize workspace execution first.');
  runGrant = undefined;
  if (changingWorkspace || closePending || allowClose || gitWrite) throw new Error('The workspace is changing.');
  return project;
}

handle('python-profiles', id => {
  currentWorkspace(id);
  return pythonProfiles.list();
});
handle('choose-python', async id => {
  currentWorkspace(id);
  const profiles = pythonProfiles;
  const choice = await dialog.showOpenDialog(window, {
    title: 'Choose a Python 3 interpreter', properties: ['openFile'],
    ...(process.platform === 'win32' ? { filters: [{ name: 'Executables', extensions: ['exe'] }] } : {}),
  });
  currentWorkspace(id);
  if (choice.canceled || !choice.filePaths[0]) return null;
  return profiles.choose(choice.filePaths[0]);
});

handle('start', (id, file, revision, runId, token, profile) => {
  const project = authorizedWorkspace(id, runId, token);
  const python = pythonProfiles;
  return sessions.start(id, runId, token, (publish, isStopping) => startSourceRun(project, file, revision, profile, python, publish, isStopping));
});
handle('debug-start', (id, file, revision, runId, token, breakpoints) => {
  const project = authorizedWorkspace(id, runId, token);
  return sessions.start(id, runId, token, (publish, isStopping) => startDebugger(project, file, revision, breakpoints, publish, isStopping));
});
handle('debug-command', (id, runId, token, action, pauseId, frame) => {
  currentWorkspace(id);
  return sessions.debug(id, runId, token, action, pauseId, frame);
});

handle('test', (id, retry, runId, token, goal) => {
  const project = authorizedWorkspace(id, runId, token);
  const current = workstream;
  return sessions.start(project.id, runId, token, (publish, isStopping) => current.start(retry === true, goal, publish, isStopping));
});
handle('task-catalog', id => readTaskCatalog(currentWorkspace(id)));
handle('run-task', (id, target, revision, runId, token) => {
  const project = authorizedWorkspace(id, runId, token);
  const current = taskRunner;
  return sessions.start(project.id, runId, token, (publish, isStopping) => current.start(target, revision, publish, isStopping));
});
handle('recipes', id => recipeCatalog(currentWorkspace(id)));
handle('recipe-preview', async (id, recipeId) => {
  const { name, digest, preview, steps } = await resolveRecipe(currentWorkspace(id), pythonProfiles, recipeId);
  currentWorkspace(id);
  return { id: recipeId, name, digest, preview, entry: steps[0].kind === 'debug' ? steps[0].file : undefined };
});
handle('recipe-file', async (id, action, revision) => {
  const project = currentWorkspace(id);
  const ensureIdle = () => {
    currentWorkspace(id);
    if (sessions.busy || authorizingRun || runGrant || gitWrite || changingWorkspace || closePending || allowClose) {
      throw new Error('Wait for the current workspace action to finish.');
    }
  };
  ensureIdle();
  const { entries, unreadable } = await drafts.list();
  ensureIdle();
  if (unreadable || entries.some(draft => draft.root === project.root && sourceFileKey(draft.path) === recipeFile)) {
    throw new Error('Resolve any recovery drafts and save the recipe file before changing it.');
  }
  if (action === 'create') await createRecipeFile(project);
  else if (action === 'upgrade') await upgradeRecipes(project, revision);
  else throw new Error('Unknown recipe file action.');
  return recipeFile;
});
handle('authorize-recipe', async (id, runId, recipeId, digest) => {
  const project = currentWorkspace(id);
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Invalid execution request.');
  const python = pythonProfiles;
  const epoch = trustEpoch;
  const plan = await requireRecipe(project, python, recipeId, digest);
  currentWorkspace(id);
  if (authorizingRun || sessions.busy || runGrant || trustEpoch !== epoch) {
    throw new Error('The recipe request expired or another execution is active.');
  }
  return authorizeExecution(project, {
    title: 'Recipe confirmation',
    confirmTrusted: true,
    message: 'Run ' + plan.name + '?',
    detail: plan.preview.map(step => step.id).join('\n') + '\n\nThese steps run with your Windows user permissions.',
    recheck: () => requireRecipe(project, python, recipeId, digest),
  }, () => {
    const token = randomUUID();
    runGrant = { id, runId, token, kind: 'recipe', recipeId, digest, epoch };
    return token;
  });
});
handle('recipe-start', (id, runId, token, breakpoints, goal = '') => {
  const grant = runGrant;
  const project = authorizedWorkspace(id, runId, token, 'recipe');
  const python = pythonProfiles;
  const tasks = taskRunner;
  const tests = workstream;
  const label = workstreamGoal(goal);
  async function refresh() {
    const plan = await requireRecipe(project, python, grant.recipeId, grant.digest);
    if (trustEpoch !== grant.epoch) throw new Error('Workspace trust was revoked. Review the recipe before running again.');
    return plan;
  }
  return sessions.start(id, runId, token, async (publish, isStopping) => {
    const plan = await refresh();
    if (plan.steps[0].kind === 'debug') {
      const { file, revision } = plan.steps[0];
      return startDebugger(project, file, revision, breakpoints, publish, isStopping);
    }
    return startRecipe(plan, refresh, (step, emit, stopping) => {
      if (step.kind === 'test') return tests.start(false, step.goal ?? label, emit, stopping);
      if (step.kind === 'task') return tasks.start(step.target, step.pin, emit, stopping);
      return startSourceRun(project, step.file, step.revision, step.runtime, python, emit, stopping);
    }, publish, isStopping);
  });
});
handle('run-evidence', async (id, evidenceId) => {
  currentWorkspace(id);
  const current = taskRunner;
  return (await workstream.recheck(evidenceId)) ?? current.recheck(evidenceId);
});
handle('git-status', id => { currentWorkspace(id); return changeLens.status(); });
handle('git-diff', (id, snapshot, file, side) => { currentWorkspace(id); return changeLens.diff(snapshot, file, side); });
handle('git-review', (id, snapshot) => { currentWorkspace(id); return changeLens.review(snapshot); });

handle('git-write', (id, action, details) => {
  const project = currentWorkspace(id);
  const lens = changeLens;
  const owner = window;
  const { snapshot, file, side, diff, message, branch } = details ?? {};
  if (typeof snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot)) throw new Error('Review a Git snapshot before making changes.');
  if (gitWrite || sessions.busy || authorizingRun || runGrant || changingWorkspace || closePending || allowClose) {
    throw new Error('Wait for the current workspace action to finish.');
  }
  const assertCurrent = () => {
    currentWorkspace(id);
    if (changingWorkspace || closePending || allowClose || window !== owner || !rendererReady) throw new Error('The workspace is changing.');
  };
  async function workspaceDrafts() {
    const { entries, unreadable } = await drafts.list();
    return { pending: entries.filter(draft => draft.root === project.root), unreadable };
  }
  async function perform() {
    if (action === 'stage') {
      if (typeof file !== 'string') throw new Error('Select a changed file.');
      const { pending, unreadable } = await workspaceDrafts();
      if (side === 'working' && (unreadable || pending.some(item => sourceFileKey(item.path) === sourceFileKey(file)))) {
        throw new Error('Save this file and refresh its diff before staging.');
      }
      assertCurrent();
      await lens.stage(snapshot, file, side, diff);
      return { changed: true };
    }
    if (action === 'commit') {
      if (typeof message !== 'string' || !message.trim() || message.includes('\0') || Buffer.byteLength(message) > 4096) {
        throw new Error('Enter a commit message of up to 4096 bytes.');
      }
      const review = await lens.review(snapshot);
      const { pending, unreadable } = await workspaceDrafts();
      assertCurrent();
      const { response } = await dialog.showMessageBox(owner, {
        type: 'question', title: 'Commit reviewed changes', message: `Commit ${review.files.length} staged path(s) to ${review.branch}?`,
        detail: message.trim().slice(0, 500) + '\n\n' + (review.verification.state === 'matches' ?
          'Staged source bytes match the latest full test pass.' : 'This staged snapshot has no matching current full test pass.') +
          (pending.length || unreadable ? '\nUnsaved editor drafts are excluded.' : ''),
        buttons: ['Cancel', 'Commit'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (response !== 1) return null;
      assertCurrent();
      return { commit: await lens.commit(snapshot, message) };
    }
    if (action === 'create' || action === 'switch') {
      if (typeof branch !== 'string' || !branch || branch.length > 120 || /[\0\r\n]/.test(branch)) throw new Error('Choose a local branch.');
      if (action === 'switch') {
        const checkDrafts = async () => {
          const { pending, unreadable } = await workspaceDrafts();
          if (pending.length || unreadable) throw new Error('Save or close unsaved drafts before switching branches.');
        };
        await checkDrafts();
        assertCurrent();
        const { response } = await dialog.showMessageBox(owner, {
          type: 'question', title: 'Switch local branch', message: `Switch to ${branch}?`,
          detail: 'VOKRI Code will reopen the workspace with the checked-out files.',
          buttons: ['Cancel', 'Switch Branch'], defaultId: 0, cancelId: 0, noLink: true,
        });
        if (response !== 1) return null;
        await checkDrafts();
      }
      assertCurrent();
      await lens.branch(snapshot, action, branch);
      return { changed: true, switched: action === 'switch' };
    }
    throw new Error('Unknown Git action.');
  }
  gitWrite = perform().finally(() => { gitWrite = undefined; });
  return gitWrite;
});
handle('flightpath', async (id, action) => {
  const project = currentWorkspace(id);
  if (action === 'view') return flightpath.view();
  if (action !== 'enable' && action !== 'clear' && action !== 'disable') throw new Error('Invalid Flightpath action.');
  await resolveEntry(project, '');
  currentWorkspace(id);
  if (changingWorkspace || closePending || allowClose) throw new Error('The workspace is changing.');
  return flightpath[action]();
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

handle('about', async () => {
  const profileNote = {
    retained: 'This installation is using your existing profile. Settings, drafts, extensions, and credentials stay in place.',
    separate: 'This installation is using its own profile. Your earlier profile is available separately and has been preserved.',
  }[selectedProfile.state];
  await dialog.showMessageBox(window, {
    title: 'About ' + productName, message: productName,
    icon: nativeImage.createFromPath(path.join(path.dirname(icon), 'vc.png')), type: 'none',
    detail: 'Version ' + app.getVersion() + (profileNote ? '\n\n' + profileNote : ''), buttons: ['Close'],
  });
});

handle('close-ready', async (hasDrafts, backupFailed) => {
  await preferences.getTheme();
  if (!closePending) return;
  const closing = window;
  const restarting = restartExtensions !== undefined;
  const stay = backupFailed ? dialog.showMessageBoxSync(window, {
    type: 'error',
    message: 'Some draft backups could not be updated.',
    detail: 'Only completed backups can be recovered.',
    buttons: ['Keep editing', restarting ? 'Restart anyway' : 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
  }) === 0 : hasDrafts && dialog.showMessageBoxSync(window, {
    type: 'question',
    message: restarting ? 'Restart VOKRI Code and keep your drafts?' : 'Quit VOKRI Code and keep your drafts?',
    detail: 'VOKRI Code will reopen the drafts next time.',
    buttons: ['Keep editing', restarting ? 'Restart and keep drafts' : 'Quit and keep drafts'],
    defaultId: 0,
    cancelId: 0,
  }) === 0;
  if (stay) {
    closePending = false;
    restartExtensions = undefined;
    window.webContents.send('cevra:close-canceled');
  } else {
    runGrant = undefined;
    await Promise.all([sessions.cancel(), terminals.closeAll(), gitWrite?.catch(() => {}),
      extensionBroker.suspend().catch(() => {}), extensionManager.wait()]);
    await flightpathStore.flush();
    if (!closePending || window !== closing) return;
    closePending = false;
    if (restarting) {
      const args = process.argv.slice(1).filter(arg => !/^--disable-extensions(?:=|$)/.test(arg));
      if (restartExtensions) args.push('--disable-extensions');
      restartExtensions = undefined;
      try { app.relaunch({ args }); }
      catch (error) {
        closing.webContents.send('cevra:close-canceled');
        throw error;
      }
    }
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
    title: productName,
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.platform === 'win32') workbench.setAppDetails({ appId, appIconPath: icon, relaunchDisplayName: productName });
  window = workbench;
  workbench.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  workbench.webContents.on('will-navigate', event => event.preventDefault());
  workbench.webContents.on('will-attach-webview', event => event.preventDefault());
  workbench.webContents.on('render-process-gone', () => {
    if (window !== workbench) return;
    rendererReady = false;
    intelligenceMock?.close();
    extensionManager.clearReview();
    restartExtensions = undefined;
    void extensionBroker.suspend().catch(() => {});
    runGrant = undefined;
    closePending = false;
    activeSearch?.controller.abort();
    syntax.stop();
    formatter.stop();
    semantics.stop();
    void sessions.cancel();
    void terminals.closeAll();
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
      void extensionBroker.suspend().catch(() => {});
      activeSearch?.controller.abort();
      void sessions.cancel();
      void terminals.closeAll();
      return;
    }
    event.preventDefault();
    if (!closePending) {
      closePending = true;
      intelligenceMock?.stopAgent();
      workbench.webContents.send('cevra:before-close');
    }
  });
  workbench.on('closed', () => {
    if (window !== workbench) return;
    intelligenceMock?.close();
    window = undefined;
  });
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
