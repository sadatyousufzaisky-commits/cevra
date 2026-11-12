const { BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { providerAbi, ProviderError, exactRecord, safeProviderError } = require('./provider-contract.cjs');
const { createProviderRegistry } = require('./provider-registry.cjs');
const { mockProvider } = require('./providers/mock.cjs');
const { createConnectionManager, providers, connectionErrorMessage } = require('./connection-manager.cjs');
const { createWindowsCredentialVault } = require('./credential-vault-win.cjs');

const page = path.join(__dirname, 'mock.html');
const pageURL = pathToFileURL(page).href;

function createIntelligenceMockWindow(profile) {
  const registry = createProviderRegistry([mockProvider]);
  const [catalog] = registry.list();
  const connections = createConnectionManager(profile, createWindowsCredentialVault());
  let panel;

  function stop(panel) {
    const request = panel.active;
    if (!request) return;
    panel.active = undefined;
    request.controller.abort();
    void request.stream.return().catch(() => {});
  }

  function retire(panel) {
    panel.connectionOwner.abort();
    stop(panel);
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

  handle('models', () => catalog);
  handle('start', (owner, input) => {
    if (owner.active) throw new Error('An Intelligence request is already active.');
    if (!exactRecord(input, ['modelId', 'prompt'])) throw new ProviderError('INVALID_REQUEST');
    const controller = new AbortController();
    const id = randomUUID();
    const model = catalog.models.find(item => item.id === input.modelId);
    if (!model) throw new ProviderError('MODEL_UNSUPPORTED');
    const stream = registry.stream({
      abiVersion: providerAbi, requestId: id, providerId: catalog.providerId, modelId: model.id,
      messages: [{ role: 'user', content: input.prompt }], maxOutputTokens: model.maxOutputTokens,
    }, { signal: controller.signal });
    owner.active = { id, stream, controller, pulling: false };
    return id;
  });
  handle('next', async (owner, id) => {
    const request = owner.active;
    if (!request || request.id !== id || request.pulling) throw new ProviderError('INVALID_REQUEST');
    request.pulling = true;
    try {
      const { done, value } = await request.stream.next();
      if (owner.active !== request) throw new ProviderError('CANCELLED');
      if (done) throw new ProviderError('PROVIDER_PROTOCOL');
      if (value.kind === 'complete' || value.kind === 'error') stop(owner);
      if (value.kind === 'error') return { ...value, message: new ProviderError(value.code).message };
      return value;
    } catch (error) {
      if (owner.active === request) stop(owner);
      const failure = safeProviderError(error);
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

  connection('connections', async () => ({
    available: connections.available(), entries: connections.available() ? await connections.list() : [],
  }));
  connection('store-key', (owner, providerId) => connections.store(providerId, {
    handle: owner.window.getNativeWindowHandle().readBigUInt64LE().toString(16), pid: process.pid,
  }, owner.connectionOwner.signal));
  connection('check-key', (_owner, providerId) => connections.check(providerId));
  connection('cleanup-key', (_owner, providerId) => connections.cleanup(providerId));
  connection('disconnect-key', async (owner, providerId) => {
    if (typeof providerId !== 'string' || !Object.hasOwn(providers, providerId)) return 'cancelled';
    const { response } = await dialog.showMessageBox(owner.window, {
      type: 'warning', title: 'Disconnect provider',
      message: 'Remove the stored ' + providers[providerId] + ' API key?',
      detail: 'This removes the key from Windows Credential Manager for this CEVRA profile.',
      buttons: ['Cancel', 'Remove Key'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (panel !== owner || response !== 1) return 'cancelled';
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
        title: 'CEVRA Intelligence · Offline mock',
        webPreferences: {
          preload: path.join(__dirname, 'mock-preload.cjs'),
          sandbox: true, contextIsolation: true, nodeIntegration: false,
        },
      });
      const opened = { window, connectionOwner: new AbortController(), connectionBusy: false };
      panel = opened;
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      window.webContents.once('render-process-gone', () => { if (panel === opened) close(); });
      window.once('closed', () => {
        retire(opened);
        if (panel === opened) panel = undefined;
      });
      try {
        await window.loadFile(page);
        if (panel === opened) window.show();
      } catch {
        if (panel !== opened) return;
        close();
        throw new Error('Could not open the Intelligence mock window.');
      }
    },
    close,
  };
}

module.exports = { createIntelligenceMockWindow };
