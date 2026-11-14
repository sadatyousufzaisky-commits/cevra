const { BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { intelligenceName, appId, icon } = require('../identity.cjs');
const { providerAbi, limits, request: validateRequest, ProviderError, exactRecord, safeProviderError } = require('./provider-contract.cjs');
const { createProviderRegistry } = require('./provider-registry.cjs');
const { mockProvider } = require('./providers/mock.cjs');
const { createOpenAIProvider, endpoint } = require('./providers/openai.cjs');
const { discoverOllama, defaultPort } = require('./providers/ollama.cjs');
const { modelRoute, profile: validateProfile } = require('./model-profiles.cjs');
const { createConnectionManager, providers, connectionErrorMessage } = require('./connection-manager.cjs');
const { createWindowsCredentialVault } = require('./credential-vault-win.cjs');
const { createContextBroker, ContextError, contextMessages, describe, instructionPath, checkPath, looksSensitive } = require('./context-broker.cjs');
const { createUsageBudget } = require('./usage-budget.cjs');
const { preferenceMessage } = require('./response-preferences.cjs');
const { sourceFileKey } = require('../source-files.cjs');
const { inside } = require('../workspace.cjs');
const { patchInstruction } = require('./patch-broker.cjs');
const { createAgentWorkflow } = require('./agent-workflow.cjs');

const page = path.join(__dirname, 'mock.html');
const pageURL = pathToFileURL(page).href;

function createIntelligenceMockWindow(profile, {
  live = false, getWorkspace, readEditor, openSource, getPreferences, setPreferences, getModels, setModels,
  patches, runAgentTests, recheckBaseline,
} = {}) {
  const connections = createConnectionManager(profile, createWindowsCredentialVault());
  const budget = live ? createUsageBudget(profile) : undefined;
  let retryAfter = -Infinity;
  let panel;
  const adapters = live ? [mockProvider, createOpenAIProvider(async signal => {
    const owner = panel;
    const active = owner?.active;
    const key = await connections.readOpenAIKey(signal);
    try {
      await verifyDelivery(owner, active, signal);
      return key;
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }, undefined, async (input, signal) => {
    const owner = panel;
    const active = owner?.active;
    if (active?.id !== input.requestId) throw new ProviderError('CANCELLED');
    await budget.reserve(active.id, active.modelId, active.quote);
    try {
      await verifyDelivery(owner, active, signal);
      active.sending = true;
    } catch (error) {
      await budget.finish(active.id, 'unsent').catch(() => {});
      throw error;
    }
  })] : [mockProvider];
  const baseRegistry = createProviderRegistry(adapters);

  async function verifyDelivery(owner, active, signal) {
    if (!active || owner.active !== active || panel !== owner) throw new ProviderError('CANCELLED');
    try {
      await verifySources(owner, active, signal);
      await active.recheck?.();
    } catch (error) {
      if (error instanceof ContextError) throw new ProviderError('CONTEXT_CHANGED');
      throw error;
    }
    signal.throwIfAborted();
  }

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

  async function authorize(owner, provider, model, value, labels, signal, cost) {
    if (signal.aborted) return false;
    const review = new BrowserWindow({
      parent: owner.window, modal: true, show: false, icon, title: 'Send conversation to ' + provider.label,
      width: 620, height: 520, minWidth: 380, minHeight: 320,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
    });
    review.setMenuBarVisibility(false);
    review.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    review.webContents.on('will-navigate', event => event.preventDefault());
    const closed = new Promise(resolve => review.once('closed', () => resolve(false)));
    const cancel = () => { if (!review.isDestroyed()) review.destroy(); };
    const expiry = setTimeout(cancel, 5 * 60_000);
    expiry.unref();
    review.webContents.once('render-process-gone', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await review.loadFile(path.join(__dirname, 'send-review.html'));
      if (signal.aborted || review.isDestroyed()) return false;
      const data = JSON.stringify({ provider, model: model.label, messages: value.messages, labels, maxOutputTokens: value.maxOutputTokens, cost });
      const decision = review.webContents.executeJavaScript('window.reviewConversation(' + data + ')');
      review.show();
      return await Promise.race([decision, closed]) === true && !signal.aborted;
    } catch {
      if (!signal.aborted && !review.isDestroyed()) throw new Error('Could not open the send review.');
      return false;
    } finally {
      clearTimeout(expiry);
      signal.removeEventListener('abort', cancel);
      cancel();
    }
  }

  function stop(panel, cancelled = true) {
    const request = panel.active;
    if (!request) return;
    panel.active = undefined;
    if (cancelled) panel.cancelledId = request.id;
    if (cancelled) request.proposalScope?.abort();
    request.controller.abort();
    if (cancelled && request.sending) void budget.finish(request.id, 'cancelled', request.usage).catch(() => {});
    void request.stream?.return().catch(() => {});
  }

  function retire(panel) {
    panel.agent?.stop();
    panel.connectionOwner.abort();
    patches?.retire();
    stop(panel);
  }

  function invalidateConnection(owner, providerId) {
    if (owner.active?.providerId === providerId) stop(owner);
    owner.verified.delete(providerId);
    if (owner.agent?.usesProvider(providerId)) owner.agent.stop('The model connection changed.');
    if (owner.proposalProvider === providerId) patches?.retire();
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
        return { ok: false, message: error instanceof ContextError ? error.message :
          error instanceof ProviderError ? safeProviderError(error).message : 'The Intelligence operation could not finish.' };
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
  handle('agent-state', owner => owner.agent?.state() ?? { stage: 'unavailable' });
  contextAction('prepare-agent', (owner, input) => {
    const context = requireContext(owner);
    if (owner.localConnecting) throw new ContextError('Wait for model discovery to finish.');
    const route = modelRoute(owner.registry.list(), input?.providerId, input?.modelId);
    if (!route || route.catalog.providerId === 'mock') throw new ContextError('Choose a connected model for this coding task.');
    if (!exactRecord(input, ['providerId', 'modelId', 'goal']) && !exactRecord(input, ['modelId', 'goal'])) {
      throw new ContextError('Choose a model and enter a coding goal.');
    }
    try { owner.agent.prepare({ goal: input.goal, modelId: route.catalog.providerId + '|' + route.model.id }, context.items()); }
    catch (error) { throw new ContextError(error.message); }
    return { providerId: route.catalog.providerId, modelId: route.model.id, label: route.model.label };
  });
  contextAction('agent-test', async owner => {
    if (owner.active || !owner.agent) throw new ContextError('This coding step is no longer available.');
    try {
      if (owner.agent.state().stage === 'save') await owner.agent.verify();
      else await owner.agent.baseline();
    } catch (error) { throw new ContextError(error.message); }
  });
  handle('stop-agent', owner => owner.agent?.stop());

  handle('models', owner => owner.registry.list());
  contextAction('usage-budget', () => budget.status());
  contextAction('save-usage-limit', (owner, limitCents) => {
    if (owner.active) throw new ContextError('Stop the current request before changing the daily limit.');
    return budget.setLimit(limitCents);
  });
  contextAction('model-profile', () => getModels());
  contextAction('save-model-profile', async (owner, input) => {
    let value;
    try { value = validateProfile(input, true); }
    catch (error) { throw new ContextError(error.message); }
    return setModels(value);
  });
  contextAction('connect-local', async (owner, port) => {
    if (owner.active || owner.agent?.active || owner.localConnecting) throw new ContextError('Finish the current Intelligence operation first.');
    owner.localConnecting = true;
    try {
      const adapter = await discoverOllama(port, owner.connectionOwner.signal,
        signal => verifyDelivery(owner, owner.active, signal));
      if (owner.connectionOwner.signal.aborted || panel !== owner) return;
      invalidateConnection(owner, 'ollama');
      owner.local = adapter;
      owner.registry = createProviderRegistry([...adapters, adapter]);
      if (owner.providerId === 'ollama') clearConversation(owner);
      return owner.registry.list();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ContextError('Ollama is unavailable at the selected loopback port.');
    } finally { owner.localConnecting = false; }
  });
  contextAction('disconnect-local', owner => {
    if (owner.localConnecting) throw new ContextError('Wait for model discovery to finish.');
    invalidateConnection(owner, 'ollama');
    owner.local = undefined;
    owner.registry = baseRegistry;
    if (owner.providerId === 'ollama') clearConversation(owner);
    return owner.registry.list();
  });
  handle('local-status', () => ({ enabled: live, defaultPort }));

  function clearConversation(owner) {
    owner.messages = [];
    owner.modelId = owner.providerId = undefined;
    owner.sources = new Map();
    owner.historical = new Set();
    sendContext(owner);
  }
  handle('clear', owner => {
    owner.agent?.stop();
    stop(owner);
    patches?.retire();
    owner.context?.clear();
    clearConversation(owner);
  });
  handle('switch-model', owner => {
    if (owner.active) return false;
    owner.agent?.stop('The model changed.');
    patches?.retire();
    clearConversation(owner);
    return true;
  });
  handle('start', async (owner, input) => {
    if (owner.active || owner.attachingSelection || owner.localConnecting) return { message: 'Wait for the current Intelligence operation.' };
    const keys = ['modelId', 'prompt', ...(Object.hasOwn(input ?? {}, 'providerId') ? ['providerId'] : []),
      ...(Object.hasOwn(input ?? {}, 'mode') ? ['mode'] : [])];
    if (!exactRecord(input, keys) || (keys.includes('mode') && !['patch', 'agent', 'explain'].includes(input.mode)) ||
        (keys.includes('providerId') && typeof input.providerId !== 'string')) {
      throw new ProviderError('INVALID_REQUEST');
    }
    const agentStep = input.mode === 'agent';
    if (owner.agent?.active && !agentStep) return { message: 'Finish or stop the coding task before sending a different request.' };
    owner.cancelledId = undefined;
    const route = modelRoute(owner.registry.list(), input.providerId, input.modelId);
    if (!route) return { message: 'The selected model is unavailable. Choose a model to continue.', fallback: true };
    const { catalog, model } = route;
    const local = catalog.providerId === 'ollama';
    const realProvider = catalog.providerId !== 'mock';
    if (catalog.providerId === 'openai' && performance.now() < retryAfter) {
      return { message: 'OpenAI rate limited the last request. Wait a few seconds before trying again.', retry: true, fallback: true };
    }
    const registry = owner.registry;
    if (typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt) > 8192) {
      return { message: 'Enter a valid prompt of up to 8 KiB.' };
    }
    const patch = input.mode === 'patch' || agentStep;
    const history = !patch && input.mode !== 'explain' && realProvider &&
      owner.modelId === model.id && owner.providerId === catalog.providerId ? owner.messages : [];
    const id = randomUUID();
    const controller = new AbortController();
    let step;
    if (agentStep) {
      if (!owner.agent) return { message: 'Open a workspace to start a coding task.' };
      try { step = await owner.agent.beginProposal(catalog.providerId + '|' + model.id); }
      catch (error) { return { message: error.message }; }
      if (panel !== owner || step.signal.aborted) return null;
    }
    const sources = step?.sources ?? (realProvider ? owner.context?.items() ?? [] : []);
    if (patch && !sources.some(item => item.kind !== 'instructions')) {
      return { message: 'Choose a connected model and attach an editor selection or saved file to propose edits.' };
    }
    if (!realProvider && owner.context?.items().length) return { message: 'Choose a connected model to send attachments.' };
    const active = { id, providerId: catalog.providerId, controller, pulling: false, sources, changed: new Set(),
      modelId: model.id, patch, isolated: input.mode === 'explain', agentStep, recheck: step?.recheck, text: '',
      conversation: [...history, { role: 'user', content: step?.goal ?? input.prompt }],
      proposalScope: patch ? new AbortController() : undefined };
    owner.active = active;
    try {
      const additions = realProvider ? contextMessages(sources, preferenceMessage(await getPreferences())) : [];
      if (realProvider && input.mode === 'explain') additions.push({ role: 'user', label: 'Explain code',
        content: 'Explain the supplied code or question. Identify any assumptions and distinguish observed source from inference.' });
      if (step) additions.push({ role: 'user', label: 'Observed baseline test counts',
        content: 'Local test runner summary for this task. No test output is attached.\n' + step.feedback });
      if (patch) additions.push(patchInstruction(sources));
      const messages = [...history, ...additions.map(({ role, content }) => ({ role, content })), active.conversation.at(-1)];
      if (realProvider && messages.some(item => looksSensitive(item.content))) throw new ProviderError('SENSITIVE_INPUT');
      if (messages.length > limits.messages ||
          messages.reduce((bytes, item) => bytes + Buffer.byteLength(item.content), 0) > model.maxInputBytes) {
        return { message: 'The conversation exceeds this model’s limit. Remove attachments or start a new conversation.' };
      }
      let value;
      let inputBytes;
      try {
        ({ value, inputBytes } = validateRequest({ abiVersion: providerAbi, requestId: id, providerId: catalog.providerId, modelId: model.id,
          messages, maxOutputTokens: model.maxOutputTokens }));
      } catch { return { message: 'Enter a valid prompt of up to 8 KiB.' }; }
      if (realProvider) {
        if (!local && owner.connectionBusy) return { message: 'Wait for the current connection operation.' };
        if (!local && !connections.available()) return { message: 'Windows Credential Manager is unavailable.', fallback: true };
        const cost = local ? undefined : await budget.quote(model.id, inputBytes, messages.length, value.maxOutputTokens);
        active.quote = cost?.quote;
        await verifySources(owner, active);
        const labels = [...history.map(() => null), ...additions.map(item => item.label), null];
        let approved;
        const destination = local ? { label: 'Ollama', endpoint: owner.local?.destination, local: true } :
          { label: 'OpenAI', endpoint };
        try { approved = await authorize(owner, destination, model, value, labels, controller.signal, cost); }
        catch { return { message: 'Could not open the send review.' }; }
        if (!approved || owner.active !== active || panel !== owner || controller.signal.aborted) return null;
        await verifySources(owner, active);
      }
      if (local && registry !== owner.registry) return { message: 'The local model connection changed.', fallback: true };
      active.stream = registry.stream(value, { signal: controller.signal });
      patches?.retire();
      owner.sources = new Map();
      owner.historical = new Set();
      sendContext(owner);
      return id;
    } catch (error) {
      if (controller.signal.aborted) return null;
      if (error instanceof ProviderError) {
        const failure = safeProviderError(error);
        return { message: failure.message, fallback: ['BUDGET_EXCEEDED', 'BUDGET_UNAVAILABLE', 'PRICE_UNAVAILABLE'].includes(failure.code) };
      }
      return { message: error instanceof ContextError ? error.message : 'The Intelligence request could not start.' };
    } finally {
      if (!active.stream && owner.active === active) {
        stop(owner);
        if (agentStep) owner.agent.stop('The proposal request did not start.');
      }
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
      if (value.kind === 'usage' && request.sending) request.usage = { input: value.inputTokens, output: value.outputTokens };
      if (value.kind === 'error' && request.providerId === 'openai' && value.code === 'RATE_LIMIT') retryAfter = performance.now() + 5000;
      const cost = request.sending && ['complete', 'error'].includes(value.kind) ?
        await budget.finish(request.id, value.kind, request.usage) : undefined;
      if (owner.active !== request) throw new ProviderError('CANCELLED');
      const retained = !request.sources.length && !request.isolated;
      if (value.kind === 'complete' && request.patch) {
        if (value.finishReason !== 'stop') {
          stop(owner, false);
          if (request.agentStep) owner.agent.stop('The edit proposal was incomplete.');
          return { kind: 'proposal-invalid', requestId: id,
            message: 'The proposed edit was cut off. Narrow the requested change and retry.' };
        }
        let proposalId;
        try {
          const scope = AbortSignal.any([owner.connectionOwner.signal, request.proposalScope.signal]);
          proposalId = await patches.issue(owner.project, request.text, request.sources,
            () => verifySources(owner, request, scope), scope);
        } catch (error) {
          if (owner.active !== request) throw new ProviderError('CANCELLED');
          stop(owner, false);
          if (request.agentStep) owner.agent.stop('The edit proposal was rejected.');
          return { kind: 'proposal-invalid', requestId: id,
            message: 'The proposed edit was invalid or its source changed. Check the attachments and try again.' };
        }
        if (owner.active !== request) {
          patches.dismiss(owner.project, proposalId);
          throw new ProviderError('CANCELLED');
        }
        for (const item of request.sources) owner.context.remove(item.id);
        owner.proposalProvider = request.providerId;
        sendContext(owner);
        if (request.providerId === 'openai') owner.verified.add(request.providerId);
        if (request.agentStep) owner.agent.proposalReady();
        stop(owner, false);
        return { ...value, retained: false, proposalId, cost };
      }
      if (value.kind === 'complete' && request.text && request.providerId !== 'mock') {
        if (retained) {
          owner.modelId = request.modelId;
          owner.providerId = request.providerId;
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
      if (value.kind === 'error' && request.agentStep) owner.agent.stop('The provider did not complete the edit proposal.');
      if (value.kind === 'error') return { ...value, message: new ProviderError(value.code).message, cost };
      return value.kind === 'complete' ? { ...value, retained, cost } : value;
    } catch (error) {
      if (owner.active === request) stop(owner, false);
      if (request.agentStep) owner.agent.stop('The proposal request ended.');
      const failure = safeProviderError(error);
      const cost = request.sending ? await budget.finish(request.id, failure.code === 'CANCELLED' ? 'cancelled' : 'error', request.usage).catch(() => {}) : undefined;
      if (failure.code === 'AUTH_INVALID') owner.verified.delete(request.providerId);
      return { kind: 'error', requestId: id, code: failure.code, message: failure.message, cost,
        retryable: failure.code === 'PROVIDER_UNAVAILABLE' || failure.code === 'PROVIDER_TIMEOUT' };
    } finally {
      request.pulling = false;
    }
  });
  handle('stop', (owner, id) => {
    if (owner.active?.id === id) {
      if (owner.active.patch) patches.retire();
      if (owner.active.agentStep) owner.agent.stop();
      stop(owner);
    }
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
      detail: 'This removes the key from Windows Credential Manager for this VOKRI Code profile.',
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
      patches?.documentChanged(project, file);
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
    patchApplied(project, changes) {
      if (panel?.project === project) panel.agent?.applied(changes);
    },
    proposalRetired() { panel?.agent?.proposalRetired(); },
    stopAgent() { panel?.agent?.stop(); },
    close,
  };

  function makePanel(parent, project) {
    const window = new BrowserWindow({
      parent, width: 660, height: 590, minWidth: 420, minHeight: 410, show: false,
      title: live ? intelligenceName : intelligenceName + ' · Offline mock', icon,
      webPreferences: {
        preload: path.join(__dirname, 'mock-preload.cjs'),
        sandbox: true, contextIsolation: true, nodeIntegration: false,
      },
    });
    if (process.platform === 'win32') window.setAppDetails({ appId, appIconPath: icon, relaunchDisplayName: intelligenceName });
    const opened = { window, project, registry: baseRegistry, messages: [], verified: new Set(), sources: new Map(), historical: new Set(),
      connectionOwner: new AbortController(), connectionBusy: false };
    if (project) opened.context = createContextBroker(project, { readEditor, current: item => item === getWorkspace() });
    if (project && live) opened.agent = createAgentWorkflow(project, {
      current: getWorkspace, runTests: runAgentTests, recheckBaseline,
      publish: state => {
        if (panel === opened && opened.loaded && !window.isDestroyed()) {
          window.webContents.send('cevra:intelligence-mock:agent-changed', state);
        }
      },
      retired: () => {
        if (opened.active?.agentStep) stop(opened);
        patches.retire();
      },
    });
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
