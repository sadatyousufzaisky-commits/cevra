import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const maxInput = 16 * 1024;

export function createTerminalPanel({ api, errorText }) {
  const byId = id => document.getElementById(id);
  const panel = byId('terminal-panel');
  const tabs = byId('terminal-tabs');
  const surfaces = byId('terminal-surfaces');
  const profile = byId('terminal-profile');
  const create = byId('terminal-new');
  const copy = byId('terminal-copy');
  const paste = byId('terminal-paste');
  const close = byId('terminal-close');
  const status = byId('terminal-status');
  const location = byId('terminal-root');
  const sessions = new Map();
  const encoder = new TextEncoder();
  let project;
  let active;
  let opening = false;
  let changing = false;
  let number = 0;
  let fitFrame;

  function theme() {
    const style = getComputedStyle(document.documentElement);
    const color = name => style.getPropertyValue(name).trim();
    return {
      background: color('--base'), foreground: color('--text'), cursor: color('--mint'),
      selectionBackground: color('--selected'), black: '#30353a', red: '#df605e', green: '#459a74',
      yellow: '#c78b26', blue: '#5796d7', magenta: '#be71c9', cyan: '#4195a5', white: '#dce2e6',
      brightBlack: '#6b7783', brightRed: '#f18b86', brightGreen: '#73c69a', brightYellow: '#e3b358',
      brightBlue: '#7fbaff', brightMagenta: '#df98e9', brightCyan: '#73c5d2', brightWhite: '#f4f7fa',
    };
  }

  function attached(session) {
    return sessions.get(session.id) === session;
  }

  function showStatus(message) {
    status.textContent = message;
  }

  function sync() {
    create.disabled = opening || changing || !project?.terminalLimit || sessions.size >= project.terminalLimit;
    profile.disabled = opening || changing || !project?.terminalLimit;
    copy.disabled = !active?.terminal.hasSelection() || changing;
    paste.disabled = !active || active.exit || active.closing || changing;
    close.disabled = !active || active.closing || changing;
    location.hidden = !active;
    location.textContent = location.title = active ? 'Started in ' + active.root : '';
  }

  function requestFit() {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      const session = active;
      if (!session || !session.host.clientWidth || !session.host.clientHeight) return;
      const size = session.fit.proposeDimensions();
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
      session.terminal.resize(Math.min(500, Math.max(2, size.cols)), Math.min(200, Math.max(2, size.rows)));
    });
  }

  new ResizeObserver(requestFit).observe(surfaces);

  function select(session, focus = false) {
    active = session;
    for (const item of sessions.values()) {
      item.host.hidden = item !== session;
      item.button.setAttribute('aria-pressed', String(item === session));
    }
    showStatus(session?.message ?? (session ? 'Terminal open.' : 'Choose a shell and open a terminal.'));
    sync();
    requestFit();
    if (focus) session?.terminal.focus();
  }

  function sessionError(session, error) {
    if (!attached(session) || session.closing) return;
    session.message = errorText(error);
    if (active === session) showStatus(session.message);
  }

  function poll(session, delay = 0) {
    if (!attached(session) || session.closing || session.exit) return;
    session.timer = setTimeout(async () => {
      try {
        const result = await api.terminalRead(session.workspaceId, session.id);
        if (!attached(session) || session.closing) return;
        if (result.exit) {
          session.exit = result.exit;
          session.terminal.options.disableStdin = true;
          session.message = result.exit.error || (result.exit.code === null ? 'Shell ended.' : 'Shell exited with code ' + result.exit.code + '.');
          session.button.classList.add('terminal-ended');
          if (active === session) showStatus(session.message);
          sync();
        }
        if (result.data?.length) session.terminal.write(result.data, () => poll(session));
        else poll(session, active === session ? 25 : 80);
      } catch (error) {
        sessionError(session, error);
      }
    }, delay);
  }

  async function flushInput(session) {
    if (session.sending || !session.input || session.exit || session.closing || !attached(session)) return;
    session.sending = true;
    const text = session.input;
    session.input = '';
    try {
      await api.terminalWrite(session.workspaceId, session.id, text);
    } catch (error) {
      sessionError(session, error);
    } finally {
      session.sending = false;
      void flushInput(session);
    }
  }

  async function copySelection() {
    const session = active;
    if (!session) return;
    const text = session.terminal.getSelection();
    if (text) {
      await api.terminalCopy(session.workspaceId, session.id, text);
      if (attached(session) && active === session) showStatus('Selection copied.');
    }
  }

  async function pasteClipboard() {
    const session = active;
    if (!session || session.exit || session.closing) return;
    const text = await api.terminalPaste(session.workspaceId, session.id);
    if (attached(session) && active === session && !session.closing && !session.exit) session.terminal.paste(text);
  }

  function action(operation) {
    const session = active;
    return operation().catch(error => {
      if (session) sessionError(session, error);
      else showStatus(errorText(error));
    });
  }

  function attach(info, workspaceId) {
    const host = document.createElement('div');
    host.className = 'terminal-surface';
    const button = document.createElement('button');
    button.className = 'terminal-tab';
    button.textContent = info.profile + ' ' + ++number;
    const terminal = new Terminal({
      cols: 80, rows: 24, cursorBlink: true, fontSize: 13, scrollback: 2000,
      fontFamily: 'Cascadia Code, Consolas, monospace', screenReaderMode: true, minimumContrastRatio: 4.5, theme: theme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const session = { ...info, workspaceId, host, button, terminal, fit, input: '' };
    sessions.set(info.id, session);
    tabs.append(button);
    surfaces.append(host);
    terminal.open(host);
    terminal.textarea.setAttribute('aria-label', info.profile + ' terminal input');
    button.onclick = () => select(session, true);
    terminal.onData(data => {
      if (session.closing || session.exit || changing) return;
      const text = session.input + data;
      if (encoder.encode(text).byteLength > maxInput) {
        session.message = 'Terminal input is full. Wait for the shell before sending more.';
        if (active === session) showStatus(session.message);
        return;
      }
      session.input = text;
      void flushInput(session);
    });
    terminal.onSelectionChange(sync);
    terminal.onResize(({ cols, rows }) => {
      if (!session.closing && !session.exit) {
        void api.terminalResize(workspaceId, session.id, cols, rows).catch(error => sessionError(session, error));
      }
    });
    terminal.attachCustomKeyEventHandler(event => {
      if (!event.ctrlKey || !event.shiftKey) return true;
      const key = event.key.toLowerCase();
      if (!['c', 'v', 'tab'].includes(key)) return true;
      if (event.type === 'keydown') {
        event.preventDefault();
        if (key === 'tab') profile.focus();
        else if (active === session) void action(key === 'c' ? copySelection : pasteClipboard);
      }
      return false;
    });
    select(session, true);
    poll(session);
  }

  function remove(session) {
    clearTimeout(session.timer);
    sessions.delete(session.id);
    session.terminal.dispose();
    session.button.remove();
    session.host.remove();
  }

  create.onclick = async () => {
    if (create.disabled) return;
    const workspace = project;
    opening = true;
    sync();
    try {
      const info = await api.terminalNew(workspace.id, profile.value, 80, 24);
      if (project !== workspace) return;
      if (info) attach(info, workspace.id);
      else showStatus('Terminal launch canceled.');
    } catch (error) {
      if (project === workspace) showStatus(errorText(error));
    } finally {
      opening = false;
      sync();
    }
  };
  close.onclick = async () => {
    const session = active;
    if (!session || session.closing) return;
    session.closing = true;
    showStatus('Closing terminal…');
    sync();
    try {
      await api.terminalClose(session.workspaceId, session.id);
      if (!attached(session)) return;
      remove(session);
      if (active === session) {
        select([...sessions.values()].at(-1), true);
        if (!active) create.focus();
      } else sync();
    } catch (error) {
      session.closing = false;
      sessionError(session, error);
      poll(session);
      sync();
    }
  };
  copy.onclick = () => void action(copySelection);
  paste.onclick = () => {
    active?.terminal.focus();
    void action(pasteClipboard);
  };

  return {
    reset(next) {
      for (const session of sessions.values()) remove(session);
      project = next;
      number = 0;
      select(undefined);
    },
    setBusy(value) { changing = value; sync(); },
    show(visible, focus) {
      panel.hidden = !visible;
      if (visible) {
        requestFit();
        if (focus) {
          if (active) active.terminal.focus();
          else create.focus();
        }
      }
    },
    handles(event) { return event.target.closest?.('.terminal-surface'); },
    refreshTheme() { for (const session of sessions.values()) session.terminal.options.theme = theme(); },
  };
}
