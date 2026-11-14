const { BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { providerAbi, limits, request: validateRequest, ProviderError, exactRecord, safeProviderError } = require('./provider-contract.cjs');
const { createProviderRegistry } = require('./provider-registry.cjs');
const { mockProvider } = require('./providers/mock.cjs');
const { createOpenAIProvider, endpoint } = require('./providers/openai.cjs');
const { createConnectionManager, providers, connectionErrorMessage } = require('./connection-manager.cjs');
const { createWindowsCredentialVault } = require('./credential-vault-win.cjs');
const { createContextBroker, ContextError, contextMessages, describe, instructionPath, checkPath } = require('./context-broker.cjs');
const { preferenceMessage } = require('./response-preferences.cjs');
const { sourceFileKey } = require('../source-files.cjs');
const { inside } = require('../workspace.cjs');

const page = path.join(__dirname, 'mock.html');
const pageURL = pathToFileURL(page).href;

function createIntelligenceMockWindow(profile, { live = false, getWorkspace, readEditor, openSource, getPreferences, setPreferences } = {}) {
  const connections = createConnectionManager(profile, createWindowsCredentialVault());
  let panel;
  const registry = createProviderRegistry(live ? [mockProvider, createOpenAIProvider(async signal => {
    const owner = panel;
    const active = owner?.active;
    const key = await connections.readOpenAIKey(signal);
    try {
      if (!active || owner.active !== active || panel !== owner) throw new ProviderError('CANCELLED');
      await verifySources(owner, active, signal);
      signal.throwIfAborted();
      return key;
    } catch (error) {
      key.fill(0);
      if (error instanceof ContextError) throw new ProviderError('CONTEXT_CHANGED');
      throw error;
    }
  })] : [mockProvider]);
  const catalogs = registry.list();

  async function verifySources(owner, active, signal = active.controller.signal) {
    if (active.sources.some(item => active.changed.has(item.id))) {
      throw new ContextError('The attached source changed. Remove it and attach it again.');
    }
    if (active.sources.length) await owner.context.verify(active.sources, signal);
    if (active.sources.some(item => active.changed.has(item.id))) {
      throw new ContextError('The attached source changed. Remove it and attach it again.');
    }
  }

  async function refreshSources(owner) {
    const sources = owner.sources;
    if (!sources.size || owner.checkingSources === sources) return;
    owner.checkingSources = sources;
    try {
      for (const item of sources.values()) {
        if (owner.historical.has(item.id)) continue;
        try { await owner.context.verify([item], owner.connectionOwner.signal); }
        catch {
          if (panel === owner && owner.sources === sources) owner.historical.add(item.id);
        }
      }
      if (panel === owner && owner.sources === sources) sendContext(owner);
    } finally {
      if (owner.checkingSources === sources) owner.checkingSources = undefined;
    }
  }

  async function authorize(owner, model, value, labels, signal) {
    if (signal.aborted) return false;
    const review = new BrowserWindow({
      parent: owner.window, modal: true, show: false, title: 'Send conversation to OpenAI',
      width: 620, height: 520, minWidth: 380, minHeight: 320,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
    });
    review.setMenuBarVisibility(false);
    review.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    review.webContents.on('will-navigate', event => event.preventDefault());
    const closed = new Promise(resolve => review.once('closed', () => resolve(false)));
    const cancel = () => { if (!review.isDestroyed()) review.destroy(); };
    review.webContents.once('render-process-gone', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await review.loadFile(path.join(__dirname, 'send-review.html'));
      if (signal.aborted || review.isDestroyed()) return false;
      const data = JSON.stringify({ model: model.label, endpoint, messages: value.messages, labels, maxOutputTokens: value.maxOutputTokens });
      const decision = review.webContents.executeJavaScript('window.reviewConversation(' + data + ')');
      review.show();
      return await Promise.race([decision, closed]) === true && !signal.aborted;
    } catch {
      if (!signal.aborted && !review.isDestroyed()) throw new Error('Could not open the OpenAI send review.');
      return false;
    } finally {
      signal.removeEventListener('abort', cancel);
      cancel();
    }
  }

  function stop(panel, cancelled = true) {
    const request = panel.active;
    if (!request) return;
    panel.active = undefined;
    if (cancelled) panel.cancelledId = request.id;
    request.controller.abort();
    void request.stream?.return().catch(() => {});
  }

  function retire(panel) {
    panel.connectionOwner.abort();
    stop(panel);
  }

  function invalidateConnection(owner, providerId) {
    if (owner.active?.providerId === providerId) stop(owner);
    owner.verified.delete(providerId);
  }

  function close() {
    if (!panel) return;
    const previous = panel;
    panel = undefined;
    retire(previous);
    if (!previous.window.isDestroyed()) previous.window.destroy();
  }

  function handle(name, operation) {
    ipcMain.handle('cevra:intelligence-mock:' + name, (event, ...args) => {
      if (!panel || event.sender !== panel.window.webContents ||
          event.senderFrame?.parent !== null || event.senderFrame.url !== pageURL) {
        throw new Error('Unrecognized Intelligence window.');
      }
      return operation(panel, ...args);
    });
  }

  function sendContext(owner) {
    if (owner.loaded && panel === owner && !owner.window.isDestroyed()) {
      owner.window.webContents.send('cevra:intelligence-mock:context-changed', contextState(owner));
    }
  }

  function contextState(owner) {
    return {
      enabled: live, workspace: Boolean(owner.context), entries: owner.context?.list() ?? [],
      sources: [...owner.sources.values()].map(item => ({ ...describe(item), historical: owner.historical.has(item.id) })),
    };
  }

  function contextAction(name, action) {
    handle(name, async (owner, value) => {
      if (!live) return { ok: false, message: 'Context is unavailable in this preview.' };
      try { return { ok: true, value: await action(owner, value) }; }
      catch (error) {
        return { ok: false, message: error instanceof ContextError ? error.message : 'The Intelligence operation could not finish.' };
      }
    });
  }

  function requireContext(owner) {
    if (!owner.context || owner.project !== getWorkspace()) throw new ContextError('Open a project to attach workspace context.');
    if (owner.active || owner.attachingSelection) throw new ContextError('Wait for the current Intelligence operation.');
    return owner.context;
  }

  handle('context', contextState);
  let choosingFile = false;
  contextAction('attach-file', async owner => {
    const context = requireContext(owner);
    if (choosingFile) throw new ContextError('A file picker is already open.');
    choosingFile = true;
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(owner.window, {
        title: 'Attach a saved workspace file', defaultPath: owner.project.root, properties: ['openFile', 'dontAddToRecent'],
      });
      if (canceled || !filePaths[0]) return;
      if (!inside(owner.project.root, filePaths[0])) throw new ContextError('Choose a file inside the current workspace.');
      requireContext(owner);
      await context.attachSaved(path.relative(owner.project.root, filePaths[0]).replaceAll('\\', '/'), 'file', owner.connectionOwner.signal);
      sendContext(owner);
    } finally { choosingFile = false; }
  });
  contextAction('attach-instructions', async owner => {
    await requireContext(owner).attachSaved(instructionPath, 'instructions', owner.connectionOwner.signal);
    sendContext(owner);
  });
  contextAction('remove-context', (owner, id) => {
    requireContext(owner).remove(id);
    sendContext(owner);
  });
  contextAction('preferences', () => getPreferences());
  contextAction('save-preferences', async (owner, values) => {
    if (owner.active) throw new ContextError('Stop the current request before changing preferences.');
    try { return await setPreferences(values); }
    catch { throw new ContextError('Response preferences could not be saved.'); }
  });
  contextAction('open-source', async (owner, id) => {
    if (owner.active) throw new ContextError('Wait for the current Intelligence operation.');
    const item = owner.sources.get(id);
    if (!item) throw new ContextError('Choose a source from this response.');
    try {
      if (owner.historical.has(id)) throw new ContextError('This source has changed.');
      await owner.context.verify([item], owner.connectionOwner.signal);
      if (owner.historical.has(id)) throw new ContextError('This source has changed.');
      await openSource(owner.project, {
        kind: item.kind, path: item.path, revision: item.revision, line: item.line,
        from: item.from, to: item.to, documentId: item.documentId, version: item.version,
      }, owner.connectionOwner.signal);
    } catch {
      owner.historical.add(id);
      sendContext(owner);
      throw new ContextError('This source has changed. The response refers to its earlier revision.');
    }
  });
  contextAction('check-sources', async owner => {
    await refreshSources(owner);
    return contextState(owner);
  });

  handle('models', () => catalogs);
  handle('clear', owner => {
    stop(owner);
    owner.messages = [];
    owner.modelId = undefined;
    owner.context?.clear();
    owner.sources.clear();
    owner.historical.clear();
    sendContext(owner);
  });
  handle('switch-model', owner => {
    if (owner.active) return false;
    owner.messages = [];
    owner.modelId = undefined;
    owner.sources = new Map();
    owner.historical = new Set();
    sendContext(owner);
    return true;
  });
  handle('start', async (owner, input) => {
    if (owner.active || owner.attachingSelection) return { message: 'Wait for the current Intelligence operation.' };
    if (!exactRecord(input, ['modelId', 'prompt'])) throw new ProviderError('INVALID_REQUEST');
    owner.cancelledId = undefined;
    const catalog = catalogs.find(item => item.models.some(model => model.id === input.modelId));
    const model = catalog?.models.find(item => item.id === input.modelId);
    if (!model) throw new ProviderError('MODEL_UNSUPPORTED');
    if (typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt) > 8192) {
      return { message: 'Enter a valid prompt of up to 8 KiB.' };
    }
    const history = live && owner.modelId === model.id ? owner.messages : [];
    const id = randomUUID();
    const controller = new AbortController();
    const sources = catalog.providerId === 'openai' ? owner.context?.items() ?? [] : [];
    if (catalog.providerId !== 'openai' && owner.context?.items().length) return { message: 'Select OpenAI to send attachments.' };
    const active = { id, providerId: catalog.providerId, controller, pulling: false, sources, changed: new Set(),
      modelId: model.id, text: '', conversation: [...history, { role: 'user', content: input.prompt }] };
    owner.active = active;
    try {
      const additions = catalog.providerId === 'openai' ? contextMessages(sources, preferenceMessage(await getPreferences())) : [];
      const messages = [...history, ...additions.map(({ role, content }) => ({ role, content })), active.conversation.at(-1)];
      if (messages.length > limits.messages ||
          messages.reduce((bytes, item) => bytes + Buffer.byteLength(item.content), 0) > model.maxInputBytes) {
        return { message: 'The conversation exceeds this model’s limit. Remove attachments or start a new conversation.' };
      }
      let value;
      try {
        ({ value } = validateRequest({ abiVersion: providerAbi, requestId: id, providerId: catalog.providerId, modelId: model.id,
          messages, maxOutputTokens: model.maxOutputTokens }));
      } catch { return { message: 'Enter a valid prompt of up to 8 KiB.' }; }
      if (catalog.providerId === 'openai') {
        if (owner.connectionBusy) return { message: 'Wait for the current connection operation.' };
        if (!connections.available()) return { message: 'Windows Credential Manager is unavailable.' };
        await verifySources(owner, active);
        const labels = [...history.map(() => null), ...additions.map(item => item.label), null];
        let approved;
        try { approved = await authorize(owner, model, value, labels, controller.signal); }
        catch { return { message: 'Could not open the OpenAI send review.' }; }
        if (!approved || owner.active !== active || panel !== owner || controller.signal.aborted) return null;
        await verifySources(owner, active);
      }
      active.stream = registry.stream(value, { signal: controller.signal });
      owner.sources = new Map();
      owner.historical = new Set();
      sendContext(owner);
      return id;
    } catch (error) {
      if (controller.signal.aborted) return null;
      return { message: error instanceof ContextError ? error.message : 'The Intelligence request could not start.' };
    } finally {
      if (!active.stream && owner.active === active) stop(owner);
    }
  });
  handle('next', async (owner, id) => {
    const request = owner.active;
    if (typeof id === 'string' && owner.cancelledId === id) {
      return { kind: 'error', requestId: id, code: 'CANCELLED', message: new ProviderError('CANCELLED').message, retryable: false };
    }
    if (!request?.stream || request.id !== id || request.pulling) throw new ProviderError('INVALID_REQUEST');
    request.pulling = true;
    try {
      const { done, value } = await request.stream.next();
      if (owner.active !== request) throw new ProviderError('CANCELLED');
      if (done) throw new ProviderError('PROVIDER_PROTOCOL');
      if (value.kind === 'text.delta') request.text += value.text;
      const retained = !request.sources.length;
      if (value.kind === 'complete' && request.text && live) {
        if (retained) {
          owner.modelId = request.modelId;
          owner.messages = [...request.conversation, { role: 'assistant', content: request.text }];
        }
        if (request.providerId === 'openai') owner.verified.add(request.providerId);
      }
      if (value.kind === 'complete' && live) {
        for (const item of request.sources) owner.context.remove(item.id);
        owner.sources = new Map(request.sources.map(item => [item.id, item]));
        owner.historical = new Set(request.changed);
        sendContext(owner);
        void refreshSources(owner);
      }
      if (value.kind === 'error' && value.code === 'AUTH_INVALID') owner.verified.delete(request.providerId);
      if (value.kind === 'complete' || value.kind === 'error') stop(owner, false);
      if (value.kind === 'error') return { ...value, message: new ProviderError(value.code).message };
      return value.kind === 'complete' ? { ...value, retained } : value;
    } catch (error) {
      if (owner.active === request) stop(owner, false);
      const failure = safeProviderError(error);
      if (failure.code === 'AUTH_INVALID') owner.verified.delete(request.providerId);
      return { kind: 'error', requestId: id, code: failure.code, message: failure.message,
        retryable: failure.code === 'PROVIDER_UNAVAILABLE' || failure.code === 'PROVIDER_TIMEOUT' };
    } finally {
      request.pulling = false;
    }
  });
  handle('stop', (owner, id) => {
    if (owner.active?.id === id) stop(owner);
  });

  function connection(name, action) {
    handle(name, async (owner, providerId) => {
      if (owner.connectionBusy) return { ok: false, message: 'A connection operation is already in progress.' };
      owner.connectionBusy = true;
      try { return { ok: true, value: await action(owner, providerId) }; }
      catch (error) { return { ok: false, message: connectionErrorMessage(error) }; }
      finally { owner.connectionBusy = false; }
    });
  }

  connection('connections', async owner => ({
    available: connections.available(), entries: connections.available() ?
      (await connections.list()).map(entry => owner.verified.has(entry.providerId) ? { ...entry, verified: true } : entry) : [],
  }));
  connection('store-key', (owner, providerId) => {
    invalidateConnection(owner, providerId);
    return connections.store(providerId, {
      handle: owner.window.getNativeWindowHandle().readBigUInt64LE().toString(16), pid: process.pid,
    }, owner.connectionOwner.signal);
  });
  connection('check-key', (_owner, providerId) => connections.check(providerId));
  connection('cleanup-key', (_owner, providerId) => connections.cleanup(providerId));
  connection('disconnect-key', async (owner, providerId) => {
    if (typeof providerId !== 'string' || !Object.hasOwn(providers, providerId)) return 'cancelled';
    const { response } = await dialog.showMessageBox(owner.window, {
      type: 'warning', title: 'Disconnect provider',
      message: 'Remove the stored ' + providers[providerId] + ' API key?',
      detail: 'This removes the key from Windows Credential Manager for this CEVRA profile.',
      buttons: ['Cancel', 'Remove Key'], defaultId: 0, cancelId: 0, noLink: true,
      signal: owner.connectionOwner.signal,
    });
    if (panel !== owner || response !== 1) return 'cancelled';
    invalidateConnection(owner, providerId);
    await connections.disconnect(providerId);
    return 'disconnected';
  });

  return {
    async open(parent, selection) {
      let owner = panel;
      if (selection !== undefined) {
        const project = live && getWorkspace();
        if (!project || !exactRecord(selection, ['path', 'documentId', 'version', 'from', 'to']) ||
            typeof selection.path !== 'string' || !Number.isInteger(selection.from) || !Number.isInteger(selection.to)) {
          throw new ContextError('Select code in an open workspace file.');
        }
        checkPath(selection.path, 'selection');
        if (owner?.active || owner?.attachingSelection) throw new ContextError('Wait for the current Intelligence operation.');
        const snapshot = await readEditor(project, selection.path, owner?.connectionOwner.signal);
        if (project !== getWorkspace() || !snapshot || snapshot.documentId !== selection.documentId ||
            snapshot.version !== selection.version || snapshot.selection.from !== selection.from || snapshot.selection.to !== selection.to) {
          throw new ContextError('The editor selection changed. Select the text again.');
        }
        if (owner !== panel || owner?.active || owner?.attachingSelection) {
          throw new ContextError('Wait for the current Intelligence operation.');
        }
        if (!owner) owner = makePanel(parent, project);
        owner.attachingSelection = true;
        try { await owner.context.attachSelection(snapshot, owner.connectionOwner.signal); }
        catch (error) {
          if (!owner.loading && panel === owner) close();
          throw error;
        } finally { owner.attachingSelection = false; }
        if (panel !== owner) return;
      }
      owner ??= panel ?? makePanel(parent, live ? getWorkspace() : undefined);
      owner.loading ??= load(owner);
      await owner.loading;
      if (panel === owner && !owner.window.isDestroyed()) {
        owner.window.focus();
        sendContext(owner);
      }
    },
    documentChanged(project, file) {
      const owner = panel;
      if (!owner?.context || owner.project !== project) return;
      const key = sourceFileKey(file);
      const affected = item => item.kind === 'selection' && sourceFileKey(item.path) === key;
      for (const item of owner.active?.sources ?? []) if (affected(item)) owner.active.changed.add(item.id);
      let updated = false;
      for (const item of owner.sources.values()) {
        if (affected(item) && !owner.historical.has(item.id)) {
          owner.historical.add(item.id);
          updated = true;
        }
      }
      if (updated) sendContext(owner);
    },
    close,
  };

  function makePanel(parent, project) {
    const window = new BrowserWindow({
      parent, width: 660, height: 590, minWidth: 420, minHeight: 410, show: false,
      title: live ? 'CEVRA Intelligence' : 'CEVRA Intelligence · Offline mock',
      webPreferences: {
        preload: path.join(__dirname, 'mock-preload.cjs'),
        sandbox: true, contextIsolation: true, nodeIntegration: false,
      },
    });
    const opened = { window, project, messages: [], verified: new Set(), sources: new Map(), historical: new Set(),
      connectionOwner: new AbortController(), connectionBusy: false };
    if (project) opened.context = createContextBroker(project, { readEditor, current: item => item === getWorkspace() });
    panel = opened;
    window.on('page-title-updated', event => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.once('render-process-gone', () => { if (panel === opened) close(); });
    window.webContents.on('did-start-navigation', details => {
      if (opened.loaded && details.isMainFrame && !details.isSameDocument && panel === opened) close();
    });
    window.on('focus', () => { if (panel === opened) void refreshSources(opened); });
    window.once('closed', () => {
      retire(opened);
      if (panel === opened) panel = undefined;
    });
    return opened;
  }

  async function load(opened) {
    const { window } = opened;
    try {
      await window.loadFile(page);
      if (panel !== opened) return;
      opened.loaded = true;
      window.show();
    } catch {
      if (panel !== opened) return;
      close();
      throw new Error('Could not open the Intelligence window.');
    }
  }
}

module.exports = { createIntelligenceMockWindow };
