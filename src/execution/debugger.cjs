const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { stripVTControlCharacters } = require('node:util');
const { captureInputs, sourceAnchor } = require('../continuum/revisions.cjs');
const { nodeFile } = require('../runtime-kind.cjs');
const { sourceFileKey } = require('../source-files.cjs');
const { projectLocation, sourceLocation } = require('../source-location.cjs');
const { inputStamp, readInputRevision, verifyRevision, workspacePath } = require('../workspace.cjs');
const { connectInspector } = require('./inspector-client.cjs');
const { startProcess } = require('./process-host.cjs');

const maxBreakpoints = 64;
const commands = { pause: 'Debugger.pause', resume: 'Debugger.resume',
  over: 'Debugger.stepOver', into: 'Debugger.stepInto', out: 'Debugger.stepOut' };
const inspectable = new Set(['local', 'closure', 'block', 'catch', 'script', 'module']);

function breakpointUrl(url) {
  const plain = url.replaceAll('%5B', '[').replaceAll('%5D', ']');
  if (url === plain) return { url };
  // Electron and the Node inspector can spell square brackets differently in file URLs.
  return { urlRegex: '^(?:' + RegExp.escape(url) + '|' + RegExp.escape(plain) + ')$' };
}

function validateBreakpoints(workspace, requested) {
  if (!Array.isArray(requested) || requested.length > maxBreakpoints) throw new Error('Use up to 64 breakpoints.');
  const ids = new Set();
  return requested.map(item => {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id) ||
        typeof item.path !== 'string' || item.path.length > 2048 || !nodeFile.test(item.path) ||
        !Number.isSafeInteger(item.line) || item.line < 1 || item.line > 2_097_152) {
      throw new Error('Invalid JavaScript breakpoint.');
    }
    const file = workspacePath(workspace, item.path);
    ids.add(item.id);
    return { id: item.id, path: path.relative(workspace.root, file), url: pathToFileURL(file).href, line: item.line };
  });
}

function filterInspectorStderr(onEndpoint, onEnd) {
  let pending = '';
  let endpoint;
  return {
    write(text) {
      pending += text;
      let output = '';
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        const value = line.trimEnd();
        const match = !endpoint && /^Debugger listening on (ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/[a-f0-9-]{36})$/i.exec(value);
        if (match) {
          endpoint = match[1];
          onEndpoint(endpoint);
        } else if (endpoint && value.endsWith('Waiting for the debugger to disconnect...')) {
          output += value.slice(0, -'Waiting for the debugger to disconnect...'.length);
          onEnd();
        }
        else if (!endpoint || !['Debugger attached.', 'For help, see: https://nodejs.org/en/docs/inspector',
          'For help, see: https://nodejs.org/learn/getting-started/debugging'].includes(value)) output += line;
      }
      if (pending.length > 8192) {
        output += pending;
        pending = '';
      }
      return output;
    },
    finish() { return pending; },
  };
}

function valuePreview(property) {
  const value = property.value;
  if (!value) return property.get || property.set ? '[Accessor]' : 'Unavailable';
  if (value.type === 'string') return JSON.stringify(String(value.value).slice(0, 160));
  return String(value.unserializableValue ?? value.description ?? value.value ?? value.type).slice(0, 160);
}

async function startDebugger(workspace, relative, revision, requested, publish, isStopping) {
  if (typeof relative !== 'string' || !nodeFile.test(relative)) throw new Error('Choose a JavaScript entry file to debug.');
  const breakpoints = validateBreakpoints(workspace, requested);
  const before = await captureInputs(workspace, [], file => nodeFile.test(file));
  const { file, stat } = await verifyRevision(workspace, relative, revision);
  before.files.set(sourceFileKey(relative), { revision, stamp: inputStamp(stat) });
  if (isStopping()) {
    publish({ type: 'exit', code: null, elapsed: 0, stopped: true });
    return;
  }

  const scripts = new Map();
  const proofs = new Map();
  const bound = new Map();
  let client;
  let pause;
  let sequence = 0;
  let phase = 'connecting';
  let controlling = false;
  let terminating = false;
  let failure;
  let timeout;

  function stop() {
    terminating = true;
    pause = undefined;
    clearTimeout(timeout);
    client?.close();
    processRun.stop();
  }

  function fail(error) {
    if (terminating || isStopping()) return;
    failure = error.message;
    stop();
  }

  async function anchorFor(position, url) {
    const { scriptId, lineNumber, columnNumber } = position;
    const target = projectLocation(workspace.root, scripts.get(scriptId) ?? url, lineNumber + 1, columnNumber + 1);
    if (!target || !Number.isSafeInteger(target.column) || target.column < 1) return null;
    const key = sourceFileKey(target.path);
    const observed = before.files.get(key);
    if (!observed) return null;
    if (!proofs.has(scriptId) && proofs.size < 512) {
      proofs.set(scriptId, (async () => {
        const disk = await verifyRevision(workspace, target.path, observed.revision);
        if (inputStamp(disk.stat) !== observed.stamp) return false;
        const { scriptSource } = await client.request('Debugger.getScriptSource', { scriptId });
        const text = disk.bytes.toString('utf8');
        return scriptSource === text || (text.startsWith('\uFEFF') && scriptSource === text.slice(1));
      })().catch(() => false));
    }
    return await proofs.get(scriptId) ? { ...target, revision: observed.revision } : null;
  }

  async function verified(breakpoint, location) {
    if (!breakpoint || terminating) return;
    const anchor = await anchorFor(location);
    if (anchor && !terminating && sourceFileKey(anchor.path) === sourceFileKey(breakpoint.path)) {
      publish({ type: 'debug-breakpoint', id: breakpoint.id, line: anchor.line });
    }
  }

  async function paused(params) {
    const record = { id: ++sequence, frames: params.callFrames.slice(0, 24), ready: false };
    pause = record;
    phase = 'paused';
    const frames = await Promise.all(record.frames.map(async (frame, index) => {
      const url = scripts.get(frame.location.scriptId) ?? frame.url;
      const location = projectLocation(workspace.root, url, frame.location.lineNumber + 1, frame.location.columnNumber + 1);
      const anchor = index < 12 && location ? await anchorFor(frame.location, url) : null;
      return { index, name: String(frame.functionName || '(anonymous)').slice(0, 120), location, anchor };
    }));
    if (pause !== record || terminating) return;
    record.ready = true;
    const exception = params.reason === 'exception' || params.reason === 'promiseRejection';
    const summary = exception ? String(params.data?.description ?? 'Unhandled exception').split('\n', 1)[0].slice(0, 400) : undefined;
    publish({ type: 'debug-state', state: 'paused', pauseId: record.id, frames, summary,
      reason: exception ? 'Exception' : params.hitBreakpoints?.length ? 'Breakpoint' : params.reason === 'Break on start' ? 'Entry' : 'Paused' });
  }

  function onEvent(method, params) {
    if (terminating || isStopping()) return;
    if (method === 'Debugger.scriptParsed' && scripts.size < 512 && projectLocation(workspace.root, params.url, 1)) {
      scripts.set(params.scriptId, params.url);
    } else if (method === 'Debugger.breakpointResolved') {
      void verified(bound.get(params.breakpointId), params.location).catch(fail);
    } else if (method === 'Debugger.paused') {
      void paused(params).catch(fail);
    } else if (method === 'Debugger.resumed') {
      pause = undefined;
      phase = 'running';
      publish({ type: 'debug-state', state: 'running' });
    }
  }

  async function attach(url) {
    client = connectInspector(url, onEvent, fail);
    await client.ready;
    await client.request('Debugger.enable');
    await client.request('Debugger.setBlackboxPatterns', { patterns: ['^node:', '[/\\\\]node_modules[/\\\\]'] });
    await client.request('Debugger.setPauseOnExceptions', { state: 'uncaught' });
    for (const breakpoint of breakpoints) {
      if (!before.files.has(sourceFileKey(breakpoint.path))) continue;
      const { breakpointId, locations } = await client.request('Debugger.setBreakpointByUrl', {
        ...breakpointUrl(breakpoint.url), lineNumber: breakpoint.line - 1,
      });
      bound.set(breakpointId, breakpoint);
      for (const location of locations) void verified(breakpoint, location).catch(fail);
    }
    clearTimeout(timeout);
    phase = 'running';
    publish({ type: 'debug-state', state: 'running' });
    await client.request('Runtime.runIfWaitingForDebugger');
  }

  async function finish(event) {
    terminating = true;
    pause = undefined;
    clearTimeout(timeout);
    client?.close();
    const { stderr, ...exit } = event;
    const stopped = isStopping() || (exit.stopped && !failure);
    let location;
    let summary;
    if (!stopped && exit.code !== 0) {
      const detail = stripVTControlCharacters(stderr);
      const target = sourceLocation(workspace.root, detail);
      summary = /^[A-Za-z]*Error(?: \[[^\]]+\])?: [^\r\n]+/m.exec(detail)?.[0];
      if (target) {
        const current = await readInputRevision(workspace, target.path).catch(() => null);
        if (current) location = sourceAnchor(workspace, target, before, { files: new Map([[sourceFileKey(target.path), current]]) });
      }
    }
    publish({ ...exit, code: failure ? null : exit.code, stopped, location, summary, error: failure || exit.error });
  }

  const processRun = startProcess(workspace.root, ['--inspect-brk=127.0.0.1:0', file], event => {
    if (event.type === 'exit') void finish(event);
    else publish(event);
  }, undefined, {
    environment: { NODE_OPTIONS: undefined },
    stderrFilter: filterInspectorStderr(url => {
      if (!terminating && !isStopping()) void attach(url).catch(fail);
    }, () => { terminating = true; client?.close(); }),
  });
  timeout = setTimeout(() => fail(new Error('The Node debugger did not become ready.')), 9000);

  return {
    stop,
    async debug(action, pauseId, frameIndex) {
      if (terminating || isStopping() || !client) throw new Error('The debug session has ended.');
      if (action === 'variables') {
        const record = pause;
        const frame = record?.ready && record.id === pauseId && Number.isSafeInteger(frameIndex) && record.frames[frameIndex];
        if (!frame) throw new Error('This stack frame is no longer paused.');
        const scopes = [];
        for (const scope of frame.scopeChain.filter(item => inspectable.has(item.type)).slice(0, 6)) {
          if (pause !== record) return [];
          const { result } = await client.request('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true });
          const values = result.slice(0, 64).map(property => ({ name: property.name.slice(0, 120), value: valuePreview(property) }));
          scopes.push({ name: scope.type, values });
        }
        return pause === record ? scopes : [];
      }
      if (!Object.hasOwn(commands, action)) throw new Error('Unknown debugger command.');
      if (controlling || (action === 'pause' ? phase !== 'running' : !pause?.ready || pause.id !== pauseId)) {
        throw new Error('The debugger state changed. Try again.');
      }
      controlling = true;
      try { await client.request(commands[action]); }
      finally { controlling = false; }
    },
  };
}

module.exports = { startDebugger };
