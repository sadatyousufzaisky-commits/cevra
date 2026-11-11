const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { normalizeSource } = require('../source-text.cjs');
const { readSource, verifyRevision, workspacePath } = require('../workspace.cjs');
const { sourceFileKey } = require('../source-files.cjs');
const { canonicalFile, exactKeys, identifierPattern, safeText } = require('./capabilities.cjs');
const { checkKeys } = require('./manifest.cjs');

const messages = {
  PERMISSION_DENIED: 'This operation was not granted.', STALE_SESSION: 'This extension session expired.',
  STALE_REVISION: 'The source changed. Request a fresh snapshot.', INVALID_REQUEST: 'The extension request is invalid.',
  QUOTA: 'The extension reached its request or registration limit.', UNAVAILABLE: 'The requested source is unavailable.',
  HOST_FAILURE: 'The extension host failed.', AUDIT_UNAVAILABLE: 'The extension audit could not be updated.',
};
const methods = new Map([
  ['workspace.readFile', 'workspace.read'], ['editor.readSelection', 'editor.readSelection'],
  ['commands.register', 'commands.register'], ['commands.unregister', 'commands.register'],
  ['diagnostics.publish', 'diagnostics.publish'], ['diagnostics.clear', 'diagnostics.publish'],
  ['editor.proposeEdit', 'editor.proposeEdit'],
]);
function failure(code) { return Object.assign(new Error(messages[code]), { code }); }
function requireValue(condition, code = 'INVALID_REQUEST') { if (!condition) throw failure(code); }
const hash = value => createHash('sha256').update(value).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });

function workspaceFingerprint(project) {
  const { dev, ino, birthtimeNs } = project.identity;
  return hash(JSON.stringify([sourceFileKey(project.root), String(dev), String(ino), String(birthtimeNs)]));
}

async function verifyWorkspace(project) {
  const current = await fs.lstat(project.root, { bigint: true }).catch(() => null);
  requireValue(current?.isDirectory() && ['dev', 'ino', 'birthtimeNs'].every(key => current[key] === project.identity[key]), 'STALE_SESSION');
}

function createCapabilityBroker({ registry, audit, getWorkspace, isTrusted, consent, startHost, editorSnapshot,
  changed = () => {}, safeStart = false, supported = true }) {
  const sessions = new Map();
  const failures = new Map();
  const starting = new Set();
  const generations = new Map();
  let epoch = 0;
  let committing = Promise.resolve();

  async function log(identity, operation, result, code, started = performance.now()) {
    try { await audit.record(identity, operation, result, code, performance.now() - started); }
    catch { throw failure('AUDIT_UNAVAILABLE'); }
  }

  function current(session) {
    requireValue(session.active && !session.revoking && sessions.get(session.id) === session &&
      getWorkspace() === session.project && session.epoch === epoch &&
      session.generation === (generations.get(session.id) ?? 0), 'STALE_SESSION');
  }

  async function validate(session) {
    current(session);
    try {
      await verifyWorkspace(session.project);
      requireValue(await isTrusted(session.project), 'PERMISSION_DENIED');
      await registry.executable(session.id, session.digest);
    } catch (error) {
      invalidate(session);
      void session.host?.stop();
      if (Object.hasOwn(messages, error?.code)) throw error;
      throw failure('STALE_SESSION');
    }
    current(session);
  }

  function permission(session, capability, file) {
    const grant = session.permissions.find(item => item.capability === capability);
    requireValue(grant && (!file || grant.files?.some(allowed => sourceFileKey(allowed) === sourceFileKey(file))), 'PERMISSION_DENIED');
    return grant;
  }

  function publish() { changed(); }

  function invalidate(session) {
    session.revoking = true;
    session.active = false;
    session.controller.abort();
    clearInterval(session.heartbeat);
    session.commands.clear();
    session.diagnostics.clear();
    session.proposals.clear();
    session.handles.clear();
    publish();
  }

  async function revoke(id) {
    const session = sessions.get(id);
    if (!session) return;
    if (session.stopping) return session.stopping;
    invalidate(session);
    session.stopping = (async () => {
      await committing;
      await session.host?.stop();
      if (sessions.get(id) === session) sessions.delete(id);
      publish();
      await log(session.identity, 'revoke', 'revoked', 'OK').catch(() => {});
    })();
    return session.stopping;
  }

  async function suspend() {
    ++epoch;
    await Promise.all([...sessions.keys()].map(revoke));
  }

  async function snapshot(session, path, source, selectedEditor) {
    workspacePath(session.project, path);
    const disk = await readSource(session.project, path);
    let editor;
    if (source === 'draft') {
      editor = selectedEditor ?? await editorSnapshot(session.project, path, session.controller.signal);
      requireValue(editor && editor.baseRevision === disk.revision, 'STALE_REVISION');
    }
    current(session);
    const text = normalizeSource(editor?.text ?? disk.text);
    requireValue(Buffer.byteLength(text) <= 512 * 1024, 'QUOTA');
    const revision = editor ? hash(JSON.stringify([editor.documentId, editor.version, editor.baseRevision, editor.text])) : disk.revision;
    return { path, text, revision, source, diskRevision: disk.revision,
      ...(editor && { documentId: editor.documentId, version: editor.version }) };
  }

  async function fresh(session, handle) {
    const latest = await snapshot(session, handle.path, handle.source);
    requireValue(latest.revision === handle.revision, 'STALE_REVISION');
    return latest;
  }

  function remember(session, value) {
    const { path, text, revision, source, diskRevision, documentId, version } = value;
    for (const [fileHandle, previous] of session.handles) {
      if (previous.path === path && previous.revision === revision && previous.source === source) {
        return { fileHandle, pathLabel: path, text, revision, source };
      }
    }
    if (session.handles.size === 64) session.handles.delete(session.handles.keys().next().value);
    const handle = randomUUID();
    session.handles.set(handle, { path, revision, source, diskRevision, documentId, version, length: text.length });
    return { fileHandle: handle, pathLabel: path, text, revision, source };
  }

  function fileHandle(session, params, capability) {
    const handle = session.handles.get(params.fileHandle);
    requireValue(handle, 'PERMISSION_DENIED');
    permission(session, capability, handle.path);
    requireValue(params.expectedRevision === handle.revision, 'STALE_REVISION');
    return handle;
  }

  async function operation(session, method, params) {
    const grant = permission(session, methods.get(method));
    if (method === 'workspace.readFile') {
      requireValue(exactKeys(params, ['path', 'source']) && canonicalFile(params.path) && ['disk', 'draft'].includes(params.source));
      permission(session, 'workspace.read', params.path);
      requireValue(params.source !== 'draft' || grant.drafts === true, 'PERMISSION_DENIED');
      return remember(session, await snapshot(session, params.path, params.source));
    }
    if (method === 'editor.readSelection') {
      requireValue(exactKeys(params, []));
      const editor = await editorSnapshot(session.project, null, session.controller.signal, grant.files);
      requireValue(editor, 'PERMISSION_DENIED');
      permission(session, 'editor.readSelection', editor.path);
      const value = await snapshot(session, editor.path, 'draft', editor);
      const { from, to } = editor.selection;
      requireValue(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to <= value.text.length);
      const latest = await editorSnapshot(session.project, null, session.controller.signal, grant.files);
      requireValue(latest?.documentId === editor.documentId && latest.version === editor.version && latest.text === editor.text &&
        latest.baseRevision === editor.baseRevision && latest.selection.from === from && latest.selection.to === to, 'STALE_REVISION');
      current(session);
      const result = remember(session, value);
      return { ...result, text: value.text.slice(from, to), selection: { from, to } };
    }
    if (method === 'commands.register') {
      requireValue(exactKeys(params, ['id', 'title', 'handler']) && typeof params.id === 'string' && identifierPattern.test(params.id) &&
        safeText(params.title, 80) && Number.isInteger(params.handler) && params.handler >= 0 && params.handler <= 31);
      requireValue(session.commands.size < 16, 'QUOTA');
      const id = session.id + '.' + params.id;
      requireValue(![...session.commands.values()].some(command => command.id === id));
      const registrationId = randomUUID();
      session.commands.set(registrationId, { id, title: params.title, handler: params.handler, registrationId });
      publish();
      return { registrationId };
    }
    if (method === 'commands.unregister') {
      requireValue(exactKeys(params, ['registrationId']) && session.commands.has(params.registrationId));
      session.commands.delete(params.registrationId);
      publish();
      return {};
    }
    if (method === 'diagnostics.clear') {
      requireValue(exactKeys(params, []));
      session.diagnostics.clear();
      publish();
      return {};
    }
    if (method === 'diagnostics.publish') {
      requireValue(exactKeys(params, ['fileHandle', 'expectedRevision', 'items']) && Array.isArray(params.items) && params.items.length <= 64);
      const handle = fileHandle(session, params, 'diagnostics.publish');
      for (const item of params.items) {
        requireValue(exactKeys(item, ['from', 'to', 'severity', 'message']) && Number.isInteger(item.from) &&
          Number.isInteger(item.to) && item.from >= 0 && item.to >= item.from && item.to <= handle.length &&
          ['error', 'warning', 'info'].includes(item.severity) && safeText(item.message, 1024));
      }
      await fresh(session, handle);
      session.diagnostics.set(handle.path, { ...handle, items: params.items });
      publish();
      return {};
    }
    requireValue(exactKeys(params, ['fileHandle', 'expectedRevision', 'proposedText', 'explanation']) &&
      typeof params.proposedText === 'string' && params.proposedText.isWellFormed() && !params.proposedText.includes('\0') &&
      Buffer.byteLength(params.proposedText) <= 512 * 1024 && safeText(params.explanation, 320));
    const handle = fileHandle(session, params, 'editor.proposeEdit');
    requireValue(session.proposals.size < 8, 'QUOTA');
    await fresh(session, handle);
    const proposalId = randomUUID();
    session.proposals.set(proposalId, { proposalId, handle, proposedText: normalizeSource(params.proposedText), explanation: params.explanation });
    publish();
    return { proposalId, outcome: 'pending-review' };
  }

  async function dispatch(session, bytes) {
    const started = performance.now();
    let request;
    let method = 'protocol';
    try {
      requireValue(Buffer.isBuffer(bytes) && bytes.length <= 256 * 1024);
      try {
        const text = decoder.decode(bytes);
        request = JSON.parse(text);
        checkKeys(text);
      } catch { throw failure('INVALID_REQUEST'); }
      requireValue(exactKeys(request, ['protocol', 'requestId', 'method', 'params']) && request.protocol === 1 &&
        typeof request.requestId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(request.requestId) &&
        methods.has(request.method) && !session.requests.has(request.requestId));
      method = request.method;
      requireValue(session.requests.size < 1024 && !session.requesting, 'QUOTA');
      session.requests.add(request.requestId);
      session.requesting = true;
      await validate(session);
      permission(session, methods.get(method));
      await log(session.identity, method, 'allowed', 'OK', started);
      current(session);
      const result = await operation(session, method, request.params);
      await validate(session);
      const response = Buffer.from(JSON.stringify({ protocol: 1, requestId: request.requestId, ok: true, result }));
      requireValue(response.length <= 1024 * 1024, 'QUOTA');
      return response;
    } catch (error) {
      let code = !session.active || session.revoking ? 'STALE_SESSION' :
        Object.hasOwn(messages, error?.code) ? error.code : 'UNAVAILABLE';
      try { await log(session.identity, method, code === 'PERMISSION_DENIED' ? 'denied' : 'failed', code, started); }
      catch { code = 'AUDIT_UNAVAILABLE'; }
      if (code === 'INVALID_REQUEST' || code === 'QUOTA' || code === 'AUDIT_UNAVAILABLE') {
        if (session.active && code !== 'AUDIT_UNAVAILABLE') noteHostFailure(session);
        invalidate(session);
        void session.host?.stop();
      }
      return Buffer.from(JSON.stringify({ protocol: 1, requestId: typeof request?.requestId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(request.requestId) ? request.requestId : null,
        ok: false, error: { code, message: messages[code] } }));
    } finally { session.requesting = false; }
  }

  async function activate(id, digest) {
    requireValue(!safeStart && supported, 'PERMISSION_DENIED');
    requireValue(!sessions.has(id) && !starting.has(id), 'STALE_SESSION');
    requireValue(sessions.size + starting.size < 4, 'QUOTA');
    starting.add(id);
    const project = getWorkspace();
    const activationEpoch = epoch;
    const generation = generations.get(id) ?? 0;
    let session;
    try {
      requireValue(project, 'STALE_SESSION');
      const { manifest, module } = await registry.executable(id, digest);
      const identity = { id, digest, version: manifest.version, workspace: workspaceFingerprint(project) };
      for (const permission of manifest.permissions) {
        for (const file of permission.files ?? []) workspacePath(project, file);
      }
      await verifyWorkspace(project);
      requireValue(await isTrusted(project), 'PERMISSION_DENIED');
      const approved = await consent({ id, digest, manifest, project });
      if (!approved) { await log(identity, 'activate', 'denied', 'PERMISSION_DENIED'); return false; }
      requireValue(epoch === activationEpoch && getWorkspace() === project && generation === (generations.get(id) ?? 0), 'STALE_SESSION');
      await registry.executable(id, digest);
      await verifyWorkspace(project);
      requireValue(await isTrusted(project), 'PERMISSION_DENIED');
      session = { id, digest, project, identity, epoch: activationEpoch, generation, permissions: manifest.permissions, active: true, revoking: false,
        controller: new AbortController(), commands: new Map(), diagnostics: new Map(), proposals: new Map(),
        handles: new Map(), requests: new Set(), ready: false, busy: false };
      sessions.set(id, session);
      await log(identity, 'activate', 'allowed', 'OK');
      await validate(session);
      session.host = await startHost(bytes => dispatch(session, bytes));
      if (!session.active) { await session.host.stop(); throw failure('STALE_SESSION'); }
      void session.host.closed.then(() => {
        if (sessions.get(id) !== session) return;
        const unexpected = session.active && !session.revoking;
        invalidate(session);
        sessions.delete(id);
        if (unexpected) {
          noteHostFailure(session);
          void log(session.identity, 'protocol', 'failed', 'HOST_FAILURE').catch(() => {});
        }
        publish();
      });
      await session.host.activate(module);
      await validate(session);
      session.ready = true;
      session.heartbeat = setInterval(() => {
        if (!session.active || session.busy || session.requesting) return;
        session.busy = true;
        void validate(session).then(() => session.host.ping()).catch(() => revoke(id).catch(() => {})).finally(() => { session.busy = false; });
      }, 5000);
      session.heartbeat.unref();
      publish();
      return true;
    } catch (error) {
      const hostFailed = session?.host && !session.revoking;
      if (session) await revoke(id).catch(() => {});
      if (hostFailed) noteHostFailure(session);
      throw Object.hasOwn(messages, error?.code) ? error : failure('HOST_FAILURE');
    } finally { starting.delete(id); }
  }

  function noteHostFailure(session) {
    if (session.failureRecorded) return;
    session.failureRecorded = true;
    const { id, digest } = session;
    const previous = failures.get(id);
    const count = previous?.digest === digest ? previous.count + 1 : 1;
    failures.set(id, { digest, count });
    if (count >= 3) void registry.quarantine(id, digest).catch(() => {});
  }

  async function invoke(id, registrationId) {
    const session = sessions.get(id);
    requireValue(session, 'STALE_SESSION');
    await validate(session);
    const command = session.commands.get(registrationId);
    requireValue(session.ready && command && !session.busy, 'STALE_SESSION');
    permission(session, 'commands.register');
    session.busy = true;
    try {
      await log(session.identity, 'commands.invoke', 'allowed', 'OK');
      current(session);
      const result = await session.host.invoke(command.handler);
      requireValue(result === 0, 'HOST_FAILURE');
      await validate(session);
      return result;
    } catch (error) {
      if (session.active && !session.revoking && typeof error?.code === 'string' && error.code.startsWith('HOST_')) {
        noteHostFailure(session);
      }
      await log(session.identity, 'commands.invoke', 'failed', Object.hasOwn(messages, error?.code) ? error.code : 'HOST_FAILURE').catch(() => {});
      await revoke(id).catch(() => {});
      throw Object.hasOwn(messages, error?.code) ? error : failure('HOST_FAILURE');
    } finally { session.busy = false; }
  }

  function findProposal(id, proposalId) {
    const session = sessions.get(id);
    requireValue(session, 'STALE_SESSION');
    current(session);
    const proposal = session.proposals.get(proposalId);
    requireValue(proposal, 'STALE_SESSION');
    return { session, proposal };
  }

  async function proposal(id, proposalId) {
    const { session, proposal } = findProposal(id, proposalId);
    await validate(session);
    const latest = await fresh(session, proposal.handle);
    current(session);
    const { handle } = proposal;
    return { proposalId, extensionId: id, path: handle.path, revision: handle.diskRevision,
      ...(handle.documentId && { documentId: handle.documentId, version: handle.version }),
      original: latest.text, proposedText: proposal.proposedText, explanation: proposal.explanation };
  }

  function commitProposal(id, proposalId, changes, commit) {
    const task = committing.then(async () => {
      const { session, proposal } = findProposal(id, proposalId);
      await validate(session);
      permission(session, 'editor.proposeEdit', proposal.handle.path);
      await fresh(session, proposal.handle);
      requireValue(Array.isArray(changes) && changes.length === 1 && sourceFileKey(changes[0].path) === sourceFileKey(proposal.handle.path) &&
        changes[0].revision === proposal.handle.diskRevision && normalizeSource(changes[0].text) === proposal.proposedText);
      await log(session.identity, 'editor.applyEdit', 'allowed', 'OK');
      await commit(async () => {
        await verifyRevision(session.project, proposal.handle.path, proposal.handle.diskRevision);
        current(session);
      });
      session.proposals.delete(proposalId);
      publish();
    });
    committing = task.catch(() => {});
    return task;
  }

  const unsubscribe = registry.onChange((id, change) => {
    if (change === 'pin') return;
    generations.set(id, (generations.get(id) ?? 0) + 1);
    void revoke(id).catch(() => {});
  });
  return {
    activate, revoke, suspend, invoke, proposal, commitProposal,
    clearFailure(id, digest) {
      if (failures.get(id)?.digest === digest) failures.delete(id);
    },
    documentChanged(projectId, path) {
      let removed = false;
      for (const session of sessions.values()) {
        if (session.project.id !== projectId) continue;
        for (const name of session.diagnostics.keys()) {
          if (sourceFileKey(name) === sourceFileKey(path)) removed = session.diagnostics.delete(name) || removed;
        }
        for (const [id, proposal] of session.proposals) {
          if (sourceFileKey(proposal.handle.path) === sourceFileKey(path)) removed = session.proposals.delete(id) || removed;
        }
      }
      if (removed) publish();
    },
    snapshot() {
      return { supported: supported && !safeStart, failures: [...failures].map(([id, value]) => ({ id, digest: value.digest })),
        sessions: [...sessions.values()].filter(session => session.active && !session.revoking).map(session => ({
        id: session.id, digest: session.digest, ready: session.ready,
        commands: [...session.commands.values()].map(({ handler, ...command }) => command),
        diagnostics: [...session.diagnostics.values()].map(value => ({ path: value.path, revision: value.diskRevision,
          documentId: value.documentId, version: value.version, items: value.items })),
        proposals: [...session.proposals.values()].map(value => ({ proposalId: value.proposalId, path: value.handle.path, explanation: value.explanation })),
      })) };
    },
    async close() { unsubscribe(); await suspend(); await audit.flush(); },
  };
}

module.exports = { createCapabilityBroker, workspaceFingerprint };
