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

const page = path.join(__dirname, 'mock.html');
const pageURL = pathToFileURL(page).href;

function createIntelligenceMockWindow(profile, { live = false } = {}) {
  const connections = createConnectionManager(profile, createWindowsCredentialVault());
  const registry = createProviderRegistry(live ?
    [mockProvider, createOpenAIProvider(signal => connections.readOpenAIKey(signal))] : [mockProvider]);
  const catalogs = registry.list();
  let panel;

  async function authorize(owner, model, value, signal) {
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
      const data = JSON.stringify({ model: model.label, endpoint, messages: value.messages, maxOutputTokens: value.maxOutputTokens });
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

  handle('models', () => catalogs);
  handle('clear', owner => {
    stop(owner);
    owner.messages = [];
    owner.modelId = undefined;
  });
  handle('start', async (owner, input) => {
    if (owner.active) throw new Error('An Intelligence request is already active.');
    if (!exactRecord(input, ['modelId', 'prompt'])) throw new ProviderError('INVALID_REQUEST');
    owner.cancelledId = undefined;
    const catalog = catalogs.find(item => item.models.some(model => model.id === input.modelId));
    const model = catalog?.models.find(item => item.id === input.modelId);
    if (!model) throw new ProviderError('MODEL_UNSUPPORTED');
    if (typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt) > 8192) throw new ProviderError('INVALID_REQUEST');
    const history = live && owner.modelId === model.id ? owner.messages : [];
    const id = randomUUID();
    const candidate = {
      abiVersion: providerAbi, requestId: id, providerId: catalog.providerId, modelId: model.id,
      messages: [...history, { role: 'user', content: input.prompt }], maxOutputTokens: model.maxOutputTokens,
    };
    if (candidate.messages.length > limits.messages ||
        candidate.messages.reduce((bytes, item) => bytes + Buffer.byteLength(item.content), 0) > model.maxInputBytes) {
      return { message: 'Start a new conversation to continue.' };
    }
    let value;
    try { ({ value } = validateRequest(candidate)); }
    catch { return { message: 'Enter a valid prompt of up to 8 KiB.' }; }
    const controller = new AbortController();
    const active = { id, providerId: catalog.providerId, controller, pulling: false, messages: value.messages,
      modelId: model.id, text: '' };
    owner.active = active;
    try {
      if (catalog.providerId === 'openai') {
        if (owner.connectionBusy) return { message: 'Wait for the current connection operation.' };
        if (!connections.available()) return { message: 'Windows Credential Manager is unavailable.' };
        let approved;
        try { approved = await authorize(owner, model, value, controller.signal); }
        catch { return { message: 'Could not open the OpenAI send review.' }; }
        if (!approved || owner.active !== active || panel !== owner || controller.signal.aborted) return null;
      }
      active.stream = registry.stream(value, { signal: controller.signal });
      return id;
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
      if (value.kind === 'complete' && request.text && live) {
        owner.modelId = request.modelId;
        owner.messages = [...request.messages, { role: 'assistant', content: request.text }];
        if (request.providerId === 'openai') owner.verified.add(request.providerId);
      }
      if (value.kind === 'error' && value.code === 'AUTH_INVALID') owner.verified.delete(request.providerId);
      if (value.kind === 'complete' || value.kind === 'error') stop(owner, false);
      if (value.kind === 'error') return { ...value, message: new ProviderError(value.code).message };
      return value;
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
    async open(parent) {
      if (panel && !panel.window.isDestroyed()) {
        panel.window.focus();
        return;
      }
      const window = new BrowserWindow({
        parent, width: 660, height: 590, minWidth: 420, minHeight: 410, show: false,
        title: live ? 'CEVRA Intelligence' : 'CEVRA Intelligence · Offline mock',
        webPreferences: {
          preload: path.join(__dirname, 'mock-preload.cjs'),
          sandbox: true, contextIsolation: true, nodeIntegration: false,
        },
      });
      const opened = { window, messages: [], verified: new Set(), connectionOwner: new AbortController(), connectionBusy: false };
      panel = opened;
      window.on('page-title-updated', event => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      window.webContents.once('render-process-gone', () => { if (panel === opened) close(); });
      window.webContents.on('did-start-navigation', details => {
        if (opened.loaded && details.isMainFrame && !details.isSameDocument && panel === opened) close();
      });
      window.once('closed', () => {
        retire(opened);
        if (panel === opened) panel = undefined;
      });
      try {
        await window.loadFile(page);
        if (panel === opened) {
          opened.loaded = true;
          window.show();
        }
      } catch {
        if (panel !== opened) return;
        close();
        throw new Error('Could not open the Intelligence window.');
      }
    },
    close,
  };
}

module.exports = { createIntelligenceMockWindow };
