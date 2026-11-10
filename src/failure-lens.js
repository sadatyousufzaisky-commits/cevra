import { StateEffect } from '@codemirror/state';
import { GutterMarker, gutter } from '@codemirror/view';

export const refreshDebugGutter = StateEffect.define();

class DebugMarker extends GutterMarker {
  constructor(state, paused) { super(); this.state = state; this.paused = paused; }
  eq(other) { return this.state === other.state && this.paused === other.paused; }
  toDOM() {
    const marker = document.createElement('span');
    marker.className = 'debug-marker';
    marker.dataset.state = this.state;
    marker.textContent = this.paused ? '▸' : this.state === 'verified' ? '●' : '○';
    marker.title = this.paused ? 'Paused here' : this.state + ' breakpoint';
    return marker;
  }
}

export function createFailureLens({ start, stop, restart, command, jump, redraw, errorText }) {
  const byId = id => document.getElementById(id);
  const panel = byId('failure-panel');
  const status = byId('debug-status');
  const summary = byId('debug-summary');
  const stack = byId('debug-stack');
  const variables = byId('debug-variables');
  const breakpointsList = byId('debug-breakpoints');
  const output = byId('failure-output');
  const truncated = byId('failure-truncated');
  const startButton = byId('debug-start');
  const stopButton = byId('debug-stop');
  const restartButton = byId('debug-restart');
  const controls = [...panel.querySelectorAll('[data-debug-action]')];
  const breakpoints = new Map();
  let nextId = 0;
  let project;
  let available = false;
  let restartable = false;
  let debugging = false;
  let phase = 'idle';
  let pending = false;
  let paused;
  let failure;
  let selected;
  let message = 'Choose a JavaScript file to debug.';
  let issue = '';
  let text = '';
  let wasTruncated = false;

  const key = path => {
    const normalized = path.replaceAll('\\', '/');
    return project?.caseInsensitivePaths ? normalized.toLowerCase() : normalized;
  };
  const sameFile = (a, b) => key(a) === key(b);
  const record = () => paused ?? failure;
  const breakpointState = breakpoint => !breakpoint.enabled ? 'disabled' : breakpoint.verified ? 'verified' : 'pending';

  function sync() {
    startButton.disabled = !available;
    stopButton.disabled = !debugging || phase === 'stopping';
    restartButton.disabled = !restartable || (debugging && !['running', 'paused'].includes(phase));
    for (const button of controls) {
      button.disabled = !debugging || pending || (button.dataset.debugAction === 'pause' ? phase !== 'running' : phase !== 'paused');
    }
    status.textContent = message;
    summary.textContent = issue || record()?.summary || '';
    summary.hidden = !summary.textContent;
  }

  function renderBreakpoints() {
    breakpointsList.replaceChildren(...[...breakpoints.values()].map(breakpoint => {
      const item = document.createElement('li');
      const title = document.createElement('span');
      const position = breakpoint.verified && breakpoint.verified !== breakpoint.line ?
        `${breakpoint.line} → ${breakpoint.verified}` : breakpoint.line;
      title.textContent = `${breakpoint.path}:${position} · ${breakpointState(breakpoint)}`;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'button';
      toggle.textContent = breakpoint.enabled ? 'Disable breakpoint' : 'Enable breakpoint';
      toggle.disabled = debugging;
      toggle.onclick = () => {
        breakpoint.enabled = !breakpoint.enabled;
        renderBreakpoints();
        redraw();
      };
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button';
      remove.textContent = 'Remove breakpoint';
      remove.disabled = debugging;
      remove.onclick = () => {
        breakpoints.delete(breakpoint.id);
        renderBreakpoints();
        redraw();
      };
      item.append(title, toggle, remove);
      return item;
    }));
  }

  function renderVariables(scopes) {
    variables.replaceChildren();
    if (!scopes?.length) {
      variables.textContent = paused ? 'No local variables for this frame.' : 'Variables are available while paused.';
      return;
    }
    for (const scope of scopes) {
      const heading = document.createElement('strong');
      heading.textContent = scope.name;
      const list = document.createElement('dl');
      for (const variable of scope.values) {
        const name = document.createElement('dt');
        name.textContent = variable.name;
        const value = document.createElement('dd');
        value.textContent = variable.value;
        list.append(name, value);
      }
      variables.append(heading, list);
    }
  }

  async function loadVariables(snapshot, index) {
    variables.textContent = 'Reading variables…';
    const current = () => paused === snapshot && selected === index;
    try {
      const scopes = await command('variables', snapshot.pauseId, index);
      if (current()) renderVariables(scopes);
    } catch (error) {
      if (current()) variables.textContent = errorText(error);
    }
  }

  function renderStack() {
    const snapshot = record();
    stack.replaceChildren(...(snapshot?.frames ?? []).map(frame => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'diagnostic-link';
      button.setAttribute('aria-pressed', String(selected === frame.index));
      const location = frame.anchor ?? frame.location;
      button.textContent = frame.name + (location ? ` · ${location.path}:${location.line}:${location.column}` : ' · Runtime frame') +
        (location && !frame.anchor ? ' · Source revision unavailable' : '');
      button.disabled = !frame.anchor && paused !== snapshot;
      button.onclick = () => {
        selected = frame.index;
        for (const item of stack.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === button));
        if (paused === snapshot) void loadVariables(snapshot, frame.index);
        if (frame.anchor) jump(frame.anchor, () => record() === snapshot && selected === frame.index);
      };
      item.append(button);
      return item;
    }));
  }

  function renderOutput() {
    if (panel.hidden) return;
    const follow = output.scrollHeight - output.clientHeight - output.scrollTop <= 24;
    output.textContent = text || 'Program output appears here.';
    truncated.hidden = !wasTruncated;
    if (follow) output.scrollTop = output.scrollHeight;
  }

  async function action(name) {
    const button = controls.find(item => item.dataset.debugAction === name);
    if (!button || button.disabled) return;
    const current = paused;
    pending = true;
    issue = '';
    sync();
    try { await command(name, current?.pauseId); }
    catch (error) { if (debugging && paused === current) issue = errorText(error); }
    finally { pending = false; sync(); }
  }

  function toggle(path, line) {
    if (!project || debugging) return;
    const existing = [...breakpoints.values()].find(item => item.line === line && sameFile(item.path, path));
    if (existing) breakpoints.delete(existing.id);
    else if (breakpoints.size < 64) {
      const id = ++nextId;
      breakpoints.set(id, { id, path, line, enabled: true });
    } else issue = 'Use up to 64 breakpoints.';
    renderBreakpoints();
    sync();
    redraw();
  }

  startButton.onclick = start;
  stopButton.onclick = stop;
  restartButton.onclick = restart;
  for (const button of controls) button.onclick = () => void action(button.dataset.debugAction);

  return {
    action, toggle,
    get phase() { return phase; },
    gutter(tab) {
      return gutter({
        class: 'cm-debug-gutter', renderEmptyElements: true,
        initialSpacer: () => new DebugMarker('spacer', false),
        lineMarkerChange: update => update.docChanged || update.transactions.some(item => item.effects.some(effect => effect.is(refreshDebugGutter))),
        lineMarker(view, block) {
          const line = view.state.doc.lineAt(block.from).number;
          const item = breakpoints.size && [...breakpoints.values()].find(item => item.line === line && sameFile(item.path, tab.path));
          const anchor = paused?.frames[0]?.anchor;
          const here = anchor && !tab.dirty && tab.revision === anchor.revision && anchor.line === line && sameFile(anchor.path, tab.path);
          return item || here ? new DebugMarker(item ? breakpointState(item) : 'pause', Boolean(here)) : null;
        },
        domEventHandlers: { mousedown(view, block, event) {
          if (event.button !== 0) return false;
          toggle(tab.path, view.state.doc.lineAt(block.from).number);
          return true;
        } },
      });
    },
    mapBreakpoints(file, before, after, changes) {
      const items = [...breakpoints.values()].filter(item => sameFile(item.path, file));
      if (!items.length) return;
      for (const item of items) {
        const old = before.line(Math.min(item.line, before.lines));
        item.line = after.lineAt(changes.mapPos(old.from, 1)).number;
        item.verified = undefined;
        item.submitted = false;
      }
      renderBreakpoints();
      queueMicrotask(redraw);
    },
    requestBreakpoints() {
      return [...breakpoints.values()].filter(item => item.enabled).map(item => {
        item.submitted = true;
        return { id: item.id, path: item.path, line: item.line };
      });
    },
    setAvailable(canStart, canRestart) { available = canStart; restartable = canRestart; sync(); },
    show(visible) { panel.hidden = !visible; renderOutput(); },
    reset(next) { project = next; breakpoints.clear(); nextId = 0; },
    begin(debug) {
      debugging = debug;
      phase = debug ? 'connecting' : 'idle';
      message = debug ? 'Starting debugger…' : 'Waiting for a run result.';
      paused = failure = selected = undefined;
      text = issue = '';
      pending = wasTruncated = false;
      for (const item of breakpoints.values()) item.verified = undefined;
      sync(); renderStack(); renderVariables(); renderBreakpoints(); renderOutput(); redraw();
    },
    state(event) {
      if (phase === 'stopping') return;
      phase = event.state;
      paused = phase === 'paused' ? event : undefined;
      if (paused?.summary) failure = paused;
      selected = paused?.frames[0]?.index;
      message = paused ? (paused.reason === 'Paused' ? 'Paused' : 'Paused · ' + paused.reason) : 'Running';
      issue = '';
      sync(); renderStack(); redraw();
      if (selected !== undefined) void loadVariables(paused, selected);
      else renderVariables();
    },
    verified(event) {
      const item = breakpoints.get(event.id);
      if (item?.submitted) { item.verified = event.line; renderBreakpoints(); redraw(); }
    },
    stopping() {
      phase = 'stopping'; paused = undefined; message = 'Stopping debugger…';
      sync(); renderStack(); renderVariables(); redraw();
    },
    exit(event) {
      message = event.stopped ? (debugging ? 'Debug session stopped' : 'Run canceled') :
        event.code === 0 ? (debugging ? 'Debug session completed' : 'Run completed') : 'Run failed';
      phase = 'ended'; debugging = false; paused = undefined; selected = undefined;
      if (!event.stopped && event.code !== 0 && !failure) {
        const location = event.location;
        failure = { summary: event.summary ?? event.error, frames: location ?
          [{ index: 0, name: 'Recorded failure', location, anchor: location.revision ? location : null }] : [] };
      }
      for (const item of breakpoints.values()) item.verified = undefined;
      sync(); renderStack(); renderVariables(); renderBreakpoints(); redraw();
    },
    output(next, clipped) { text = next; wasTruncated = clipped; renderOutput(); },
  };
}
