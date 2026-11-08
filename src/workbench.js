import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';

const api = window.cevra;
const byId = id => document.getElementById(id);
const tabs = byId('tabs');
const editor = byId('editor');
const tree = byId('tree');
const output = byId('run-output');
const message = byId('message');
const openButton = byId('open-folder');
const welcomeOpen = byId('welcome-open');
const exampleButton = byId('open-example');
const saveButton = byId('save-file');
const runButton = byId('run-file');
const stopButton = byId('stop-run');
const diagnosticButton = byId('jump-to-error');
const runnable = /\.(?:js|cjs|mjs)$/i;
const maxOutput = 160_000;

const documents = new Map();
const expanded = new Map();
let project;
let active;
let changingProject = false;
let fileRequest = 0;
let runSequence = 0;
let run;
let diagnostic;
let outputText = '';

const view = new EditorView({ parent: editor });
const editorTheme = EditorView.theme({
  '&': { backgroundColor: '#101417', color: '#e3ebea', fontSize: '14px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '10px 0' },
  '.cm-gutters': { backgroundColor: '#101417', color: '#9ca9af', borderRight: '1px solid #20292d' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#1c272a' },
  '.cm-cursor': { borderLeftColor: '#39edaa' },
}, { dark: true });

function icon(name, className) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const use = document.createElementNS(namespace, 'use');
  use.setAttribute('href', '#' + name);
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  svg.append(use);
  return svg;
}

function label(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

function notify(text, error = false) {
  message.textContent = text;
  message.title = text;
  message.dataset.error = String(error);
}

function errorText(error) {
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function report(error) {
  notify(errorText(error), true);
}

function syncCommands() {
  const saving = [...documents.values()].some(tab => tab.saving);
  openButton.disabled = welcomeOpen.disabled = exampleButton.disabled = Boolean(run || changingProject || saving);
  saveButton.disabled = !active?.dirty || Boolean(active.saving || changingProject);
  runButton.disabled = !active || !runnable.test(active.path) || Boolean(changingProject || run);
  runButton.hidden = Boolean(run);
  stopButton.hidden = !run;
  stopButton.disabled = run?.stage !== 'running';
}

function syncCursor() {
  if (!active) {
    byId('language').textContent = '';
    byId('cursor').textContent = '';
    return;
  }
  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  byId('language').textContent = runnable.test(active.path) ? 'JavaScript' : 'Plain text';
  byId('cursor').textContent = `Ln ${line.number}, Col ${position - line.from + 1}`;
}

function syncDirty() {
  api.setDirty([...documents.values()].some(tab => tab.dirty));
  syncCommands();
  renderTabs();
}

function editorState(tab, text) {
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      oneDark,
      editorTheme,
      indentUnit.of('  '),
      runnable.test(tab.path) ? javascript() : [],
      EditorView.contentAttributes.of({ 'aria-label': 'Source editor' }),
      EditorView.updateListener.of(update => {
        tab.state = update.state;
        if (update.docChanged) {
          const dirty = !update.state.doc.eq(tab.savedDoc);
          if (dirty !== tab.dirty) {
            tab.dirty = dirty;
            syncDirty();
          }
        }
        if (update.docChanged || update.selectionSet) syncCursor();
      }),
    ],
  });
}

function selectTreeFile() {
  for (const button of tree.querySelectorAll('button[data-file]')) {
    if (button.dataset.file === active?.path) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
}

function treeList(entries, depth) {
  const list = document.createElement('ul');
  list.className = 'tree-list';
  for (const entry of entries) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'file-item';
    button.title = entry.path;
    button.style.setProperty('--depth', depth);
    const children = expanded.get(entry.path);
    if (entry.directory) {
      button.dataset.folder = entry.path;
      button.setAttribute('aria-expanded', String(Boolean(children)));
      button.append(icon('chevron', 'tree-chevron'));
      button.onclick = () => toggleFolder(entry.path, button).catch(report);
    } else {
      button.dataset.file = entry.path;
      const indent = label('');
      indent.className = 'file-indent';
      button.append(indent);
      button.onclick = () => openFile(entry.path).catch(report);
    }
    button.append(icon(entry.directory ? 'folder' : 'file'), label(entry.name));
    item.append(button);
    if (children) item.append(treeList(children, Math.min(depth + 1, 10)));
    list.append(item);
  }
  return list;
}

function renderTree() {
  const root = byId('project-root');
  const empty = byId('tree-empty');
  root.hidden = !project;
  root.querySelector('span').textContent = project?.name ?? '';
  root.title = project?.root ?? '';
  empty.hidden = Boolean(project?.files.length);
  empty.textContent = project ? 'This folder has no files to show.' : 'Open a folder to browse its files.';
  tree.replaceChildren();
  if (project?.files.length) tree.append(treeList(project.files, 0));
  selectTreeFile();
}

async function toggleFolder(path, button) {
  const openedProject = project;
  if (expanded.has(path)) {
    expanded.delete(path);
  } else {
    button.disabled = true;
    try {
      const children = await api.list(openedProject.id, path);
      if (project !== openedProject) return;
      expanded.set(path, children);
    } finally {
      button.disabled = false;
    }
  }
  renderTree();
  [...tree.querySelectorAll('button[data-folder]')].find(item => item.dataset.folder === path)?.focus();
}

function renderTabs() {
  tabs.replaceChildren();
  tabs.hidden = !documents.size;
  for (const tab of documents.values()) {
    const item = document.createElement('div');
    item.className = tab === active ? 'tab active' : 'tab';
    const show = document.createElement('button');
    show.className = 'tab-open';
    show.title = tab.path;
    if (tab === active) show.setAttribute('aria-current', 'true');
    show.append(icon('file'), label(tab.name));
    if (tab.dirty) {
      const marker = label('');
      marker.className = 'dirty';
      marker.title = 'Unsaved changes';
      show.setAttribute('aria-label', tab.name + ', unsaved');
      show.append(marker);
    }
    show.onclick = () => { ++fileRequest; showFile(tab); };
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = 'Close ' + tab.name;
    close.setAttribute('aria-label', close.title);
    close.append(icon('close'));
    close.onclick = () => closeFile(tab).catch(report);
    item.append(show, close);
    tabs.append(item);
  }
}

function showFile(tab) {
  const changed = active !== tab;
  active = tab;
  editor.hidden = !tab;
  byId('welcome').hidden = Boolean(tab);
  if (tab) {
    if (changed) view.setState(tab.state);
    view.focus();
  }
  renderTabs();
  selectTreeFile();
  syncCommands();
  syncCursor();
}

async function openFile(path) {
  const request = ++fileRequest;
  const openedProject = project;
  if (!openedProject) return null;
  let tab = documents.get(path);
  if (!tab) {
    const { text, revision } = await api.read(openedProject.id, path);
    if (request !== fileRequest || project !== openedProject) return null;
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const content = text.slice(bom.length);
    const eol = content.includes('\r\n') ? '\r\n' : content.includes('\n') ? '\n' :
      content.includes('\r') ? '\r' : '\n';
    tab = {
      path,
      name: path.split(/[\\/]/).at(-1),
      revision,
      bom,
      eol,
      dirty: false,
    };
    tab.state = editorState(tab, content.replace(/\r\n?/g, '\n'));
    tab.savedDoc = tab.state.doc;
    documents.set(path, tab);
  }
  showFile(tab);
  notify(tab.path);
  return tab;
}

async function closeFile(tab) {
  if (changingProject || tab.saving) return;
  const openedProject = project;
  if (tab.dirty && !await api.confirmDiscard(tab.name)) return;
  if (project !== openedProject || documents.get(tab.path) !== tab || tab.saving) return;
  documents.delete(tab.path);
  if (tab === active) showFile([...documents.values()].at(-1));
  syncDirty();
}

async function openProject(picker) {
  if (openButton.disabled) return;
  changingProject = true;
  syncCommands();
  try {
    if ([...documents.values()].some(tab => tab.dirty) && !await api.confirmDiscard(project.name)) return;
    const next = await picker();
    if (!next) return;
    ++fileRequest;
    project = next;
    documents.clear();
    expanded.clear();
    showFile(undefined);
    syncDirty();
    renderTree();
    byId('project-title').textContent = project.name;
    byId('project-title').title = project.root;
    byId('welcome').querySelector('h1').textContent = 'Choose a file to edit.';
    byId('welcome-copy').textContent = 'The Explorer shows the files in this project.';
    resetOutput();
    notify(project.root);
    if (next.entry) await openFile(next.entry);
  } finally {
    changingProject = false;
    syncCommands();
  }
}

async function saveFile(tab) {
  if (!tab?.dirty) return;
  if (tab.saving) return tab.saving;
  const doc = tab.state.doc;
  const text = doc.toString();
  tab.saving = api.save(project.id, tab.path, tab.bom + text.replaceAll('\n', tab.eol), tab.revision);
  syncCommands();
  try {
    tab.revision = await tab.saving;
    tab.savedDoc = doc;
    tab.dirty = !tab.state.doc.eq(doc);
    notify('Saved ' + tab.path);
  } finally {
    tab.saving = undefined;
    syncDirty();
  }
}

function setRunState(text, state = '') {
  const badge = byId('run-state');
  badge.textContent = text;
  badge.dataset.state = state;
}

function resetOutput(target = '') {
  diagnostic = undefined;
  byId('run-diagnostic').hidden = true;
  byId('run-target').textContent = target;
  outputText = '';
  output.classList.remove('has-output');
  output.textContent = target ? 'Waiting for program output…' : 'Run a JavaScript file to see its output here.';
  setRunState('Ready');
}

function appendOutput(text) {
  const follow = output.scrollHeight - output.clientHeight - output.scrollTop <= 24;
  outputText = (outputText + text).slice(-maxOutput);
  output.textContent = outputText;
  output.classList.add('has-output');
  if (follow) output.scrollTop = output.scrollHeight;
}

async function runFile() {
  if (runButton.disabled) return;
  const tab = active;
  const id = ++runSequence;
  run = { id, stage: 'starting' };
  resetOutput(tab.path);
  setRunState('Starting', 'running');
  syncCommands();
  try {
    await saveFile(tab);
    if (tab.dirty) throw new Error('The file changed during save. Run it again to include the latest edits.');
    await api.start(project.id, tab.path, tab.revision, id);
    if (run?.id === id) {
      run.stage = 'running';
      setRunState('Running', 'running');
      syncCommands();
    }
  } catch (error) {
    run = undefined;
    setRunState('Could not run', 'error');
    appendOutput(errorText(error));
    syncCommands();
    report(error);
  }
}

async function stopRun() {
  if (run?.stage !== 'running') return;
  run.stage = 'stopping';
  setRunState('Stopping');
  syncCommands();
  await api.stop();
}

api.onRun(event => {
  if (event.runId !== run?.id) return;
  if (event.type === 'output') {
    appendOutput(event.text);
    return;
  }
  run = undefined;
  const elapsed = event.elapsed < 1000 ? `${event.elapsed} ms` : `${(event.elapsed / 1000).toFixed(1)} s`;
  if (event.stopped) setRunState('Stopped');
  else if (event.code === 0) setRunState('Passed · ' + elapsed, 'ok');
  else setRunState(`Failed · ${event.code ?? event.signal ?? 'launch'}`, 'error');
  if (event.error) appendOutput(event.error);
  if (!outputText) output.textContent = 'The program produced no output.';
  if (event.location) {
    diagnostic = event.location;
    diagnosticButton.querySelector('span').textContent =
      `${diagnostic.path}:${diagnostic.line}:${diagnostic.column}`;
    const summary = byId('run-error-summary');
    summary.textContent = summary.title = event.summary ?? '';
    byId('run-diagnostic').hidden = false;
  }
  syncCommands();
});

async function jumpToError() {
  if (!diagnostic) return;
  const { path, line, column } = diagnostic;
  const tab = await openFile(path);
  if (!tab) return;
  const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
  const pos = Math.max(target.from, Math.min(target.from + column - 1, target.to));
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  view.focus();
  if (tab.dirty) notify('The source location refers to the saved version of this file.');
}

openButton.onclick = welcomeOpen.onclick = () => openProject(api.chooseFolder).catch(report);
exampleButton.onclick = () => openProject(api.openExample).catch(report);
saveButton.onclick = () => saveFile(active).catch(report);
runButton.onclick = runFile;
stopButton.onclick = () => stopRun().catch(report);
diagnosticButton.onclick = () => jumpToError().catch(report);

document.addEventListener('keydown', event => {
  const command = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (event.key === 'F5') {
    event.preventDefault();
    void runFile();
  } else if (command && key === 'o') {
    event.preventDefault();
    openProject(api.chooseFolder).catch(report);
  } else if (command && key === 's') {
    event.preventDefault();
    if (!changingProject) saveFile(active).catch(report);
  } else if (command && key === 'w' && active) {
    event.preventDefault();
    closeFile(active).catch(report);
  }
}, { capture: true });
