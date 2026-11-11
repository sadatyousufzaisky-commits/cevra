import { basicSetup } from 'codemirror';
import { autocompletion, closeCompletion } from '@codemirror/autocomplete';
import { indentWithTab, isolateHistory } from '@codemirror/commands';
import { EditorState, Text } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { linter, lintGutter, setDiagnostics, setDiagnosticsEffect } from '@codemirror/lint';
import { createDefinitionNavigation } from './definition-navigation.js';
import { createEditPreview } from './edit-preview.js';
import { createEditorSettings, editorOptions, optionExtensions } from './editor-settings.js';
import { colorModeExtension, editorColorMode, editorTheme } from './editor-theme.js';
import { createExtensionContributions } from './extension-contributions.js';
import { createExtensionManager } from './extension-manager.js';
import { createChangeLensPanel } from './change-lens-panel.js';
import { createFailureLens, refreshDebugGutter } from './failure-lens.js';
import { createFlightpathPanel } from './flightpath-panel.js';
import { indentGuides } from './indent-guides.js';
import { createNavigationHistory } from './navigation-history.js';
import { createProblemsPanel } from './problems-panel.js';
import { createRecipesPanel } from './recipes-panel.js';
import { createReferencesPanel } from './references-panel.js';
import { createRuntimePanel } from './runtime-panel.js';
import { createSearchPanel } from './search-panel.js';
import { createSemanticContext } from './semantic-context.js';
import { createSemanticCompletion } from './semantic-completion.js';
import { createSignatureHelp } from './signature-help.js';
import { createSymbolInfo } from './symbol-info.js';
import { createSymbolPicker } from './symbol-picker.js';
import { createTaskPanel } from './task-panel.js';
import { createTestEvidence } from './test-evidence.js';
import { createTerminalPanel } from './terminal-panel.js';
import { createTypeProblems } from './type-problems.js';
import { createWorkspaceLayout } from './workspace-layout.js';
import { sourceLanguage } from './source-language.cjs';
import { runtimeKind } from './runtime-kind.cjs';
import { normalizeSource } from './source-text.cjs';
import { changeLineEnding, detectLineEnding, lineEnding, lineEndingHistory } from './line-endings.js';

const api = window.cevra;
const flightpathPanel = createFlightpathPanel({ api, errorText, checkInputs: () => testEvidence.recheck() });
const testEvidence = createTestEvidence(api, (evidence, checking) => {
  flightpathPanel.setEvidence(evidence, checking);
  renderTestPass(evidence, checking);
});
const byId = id => document.getElementById(id);
const terminalPanel = createTerminalPanel({ api, errorText });
const runtimePanel = createRuntimePanel({ api, errorText });
const taskPanel = createTaskPanel({ api, errorText, runTask, jump: jumpToTaskSource });
const recipeFile = '.cevra-recipes.json';
const recipesPanel = createRecipesPanel({ api, errorText, edit: () => openFile(recipeFile), updateFile: updateRecipeFile, runRecipe });
const failureLens = createFailureLens({ start: () => runDebug(), stop: () => void stopRun().catch(report), restart: () => void restartDebug().catch(report),
  command: sendDebugCommand, jump: jumpToDebugSource, redraw: redrawDebugGutter, errorText });
const changePanel = createChangeLensPanel({ api, mutate: applyGitAction, errorText,
  getDirty: () => [...documents.values()].filter(tab => tab.dirty).map(tab => tab.path) });
const tabs = byId('tabs');
const editor = byId('editor');
const tree = byId('tree');
const output = byId('run-output');
const outputNotice = byId('output-truncated');
const message = byId('message');
const openButton = byId('open-folder');
const welcomeOpen = byId('welcome-open');
const exampleButton = byId('open-example');
const saveButton = byId('save-file');
const recoveryButton = byId('save-recovery');
const formatButton = byId('format-document');
const inspectButton = byId('inspect-symbol');
const definitionButton = byId('go-definition');
const symbolButton = byId('go-symbol');
const findReferencesButton = byId('find-references');
const renameButton = byId('rename-symbol');
const themeChoice = byId('theme-choice');
const settingsButton = byId('editor-settings');
const runButton = byId('run-file');
const testButton = byId('run-tests');
const retryButton = byId('rerun-failures');
const stopButton = byId('stop-run');
const diagnosticButton = byId('jump-to-error');
const failureList = byId('test-failures');
const searchToggle = byId('search-toggle');
const backButton = byId('nav-back');
const forwardButton = byId('nav-forward');
const dock = byId('run-panel');
const dockButtons = {
  output: byId('show-output'), problems: byId('show-problems'), references: byId('show-references'),
  terminal: byId('show-terminal'), flightpath: byId('show-flightpath'), tasks: byId('show-tasks'), failure: byId('show-failure'),
  changes: byId('show-changes'), recipes: byId('show-recipes'),
};
const maxOutput = 160_000;

const documents = new Map();
const expanded = new Map();
const navigation = createNavigationHistory();
let project;
let active;
let changingProject = true;
let changingGit = false;
let fileRequest = 0;
let documentSequence = 0;
let navigating = false;
let runSequence = 0;
let run;
let debugEntry;
let debugRecipe;
let diagnostic;
let retryAvailable = false;
let testPass;
let outputText = '';
let selectedTheme = themeChoice.value;
let colorMode = 'dark';
let stagingEdits;
let savingAll;
let editorSettings;

const view = new EditorView({ parent: editor });
const extensionContributions = createExtensionContributions({ api, editor, view, themeChoice,
  builtInTheme: () => selectedTheme, report });
const layout = createWorkspaceLayout();
const syntaxDecorations = [
  linter(null),
  lintGutter(),
  EditorState.transactionExtender.of(transaction =>
    transaction.docChanged ? { effects: setDiagnosticsEffect.of([]) } : null),
];

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

function applyColorMode(mode) {
  if (mode === colorMode) return;
  colorMode = mode;
  document.documentElement.dataset.colorMode = mode;
  terminalPanel.refreshTheme();
  const effects = editorColorMode.reconfigure(colorModeExtension(mode === 'dark'));
  for (const tab of documents.values()) {
    if (tab === active) view.dispatch({ effects });
    else tab.state = tab.state.update({ effects }).state;
  }
}

api.onColorMode(applyColorMode);

themeChoice.onchange = async () => {
  const choice = themeChoice.value;
  themeChoice.disabled = true;
  try {
    if (choice.includes(':')) {
      await api.setExtensionPalette(choice);
    } else {
      const { theme, mode } = await api.setTheme(choice);
      selectedTheme = theme;
      applyColorMode(mode);
    }
    notify('Theme saved.');
    await extensionContributions.refresh();
  } catch (error) {
    report(error);
  } finally {
    extensionContributions.syncThemeChoice();
    themeChoice.disabled = false;
  }
};

function syncCommands() {
  const open = [...documents.values()];
  const saving = savingAll || open.some(tab => tab.saving);
  const discarding = open.some(tab => tab.discarding);
  const runtime = runtimeKind(active?.path);
  byId('extension-manager-open').disabled = changingProject;
  dock.dataset.runtime = runtime ?? '';
  runtimePanel.sync(project, runtime, Boolean(run || changingProject));
  dockButtons.terminal.disabled = !project?.terminalLimit || changingProject;
  dockButtons.flightpath.disabled = dockButtons.tasks.disabled = dockButtons.failure.disabled = dockButtons.changes.disabled = !project || changingProject;
  dockButtons.recipes.disabled = !project || changingProject;
  const canDebug = !changingProject && !changingGit && !saving && !discarding;
  changePanel.sync(Boolean(run || changingProject || changingGit || saving || discarding));
  failureLens.setAvailable(canDebug && !run && runtime === 'javascript',
    canDebug && Boolean(debugEntry) && (!run || run.mode === 'debug'));
  taskPanel.setBusy(Boolean(run || changingProject || changingGit || saving || discarding));
  recipesPanel.setBusy(Boolean(run || changingProject || changingGit || saving || discarding));
  terminalPanel.setBusy(changingProject);
  testEvidence.setBusy(Boolean(run || changingProject));
  openButton.disabled = welcomeOpen.disabled = exampleButton.disabled = Boolean(run || changingProject || changingGit || saving || discarding);
  saveButton.disabled = !active?.dirty || Boolean(active.saving || active.discarding || changingProject || changingGit);
  saveButton.hidden = Boolean(active?.recoveryConflict);
  recoveryButton.hidden = !active?.recoveryConflict;
  recoveryButton.disabled = !active?.dirty || Boolean(active.saving || changingProject);
  formatButton.disabled = !active?.language || Boolean(changingProject || active.formatting || active.discarding);
  inspectButton.disabled = definitionButton.disabled = findReferencesButton.disabled = !active?.language || changingProject;
  renameButton.disabled = !active?.language || changingProject || Boolean(run || saving || discarding);
  settingsButton.disabled = Boolean(changingProject || run || saving || discarding);
  symbolButton.disabled = !project || changingProject;
  runButton.disabled = !runtime || Boolean(changingProject || changingGit || run || discarding || savingAll);
  runButton.hidden = Boolean(run);
  testButton.disabled = !project || Boolean(changingProject || changingGit || run || discarding || savingAll);
  retryButton.hidden = !retryAvailable || byId('run-panel').dataset.mode !== 'tests';
  retryButton.disabled = testButton.disabled;
  stopButton.hidden = !run;
  stopButton.disabled = run?.stage === 'stopping';
  searchToggle.disabled = !project || changingProject;
  backButton.disabled = changingProject || navigating || !navigation.peek('back');
  forwardButton.disabled = changingProject || navigating || !navigation.peek('forward');
}

function syncCursor() {
  if (!active) {
    byId('language').textContent = '';
    byId('line-ending').textContent = '';
    byId('cursor').textContent = '';
    return;
  }
  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  byId('language').textContent = active.language?.name ?? (runtimeKind(active.path) === 'python' ? 'Python' : 'Plain text');
  const ending = view.state.field(lineEnding);
  byId('line-ending').textContent = ending === '\r\n' ? 'CRLF' : ending === '\r' ? 'CR' : 'LF';
  byId('cursor').textContent = `Ln ${line.number}, Col ${position - line.from + 1}`;
}

function syncDirty() {
  syncCommands();
  renderTabs();
  syncDraftStatus();
}

function syncDraftStatus() {
  const status = byId('draft-status');
  const all = [...documents.values()];
  const failed = all.some(tab => tab.draftError);
  const pending = all.some(tab => tab.draftTask);
  const dirty = all.some(tab => tab.dirty);
  status.dataset.state = failed ? 'error' : pending ? 'pending' : dirty ? 'saved' : 'clear';
  status.hidden = status.dataset.state === 'clear';
  status.textContent = failed ? 'Draft backup failed' : pending ? 'Updating drafts…' : dirty ? 'Draft backed up' : '';
  status.title = all.find(tab => tab.draftError)?.draftError?.message ?? '';
}

function serialize(tab, state = tab.state) {
  return tab.bom + state.doc.toString().replaceAll('\n', state.field(lineEnding));
}

function isDirty(tab, state) {
  return !tab.savedDoc || !state.doc.eq(tab.savedDoc) ||
    (state.doc.lines > 1 && state.field(lineEnding) !== tab.savedEol);
}

function queueDraft(tab) {
  tab.draftPending = true;
  if (!tab.draftTask) {
    tab.draftTask = (async () => {
      while (tab.draftPending) {
        tab.draftPending = false;
        try {
          await api.draft(tab.projectId, tab.path, tab.dirty && !tab.discarding ? serialize(tab) : null,
            tab.revision);
          tab.draftError = undefined;
        } catch (error) {
          tab.draftError = error;
        }
      }
    })().finally(() => {
      tab.draftTask = undefined;
      syncDraftStatus();
    });
  }
  syncDraftStatus();
  return tab.draftTask;
}

function updateDocument(tab, before, state, changes, docChanged) {
  tab.state = state;
  const endingChanged = before.field(lineEnding, false) !== state.field(lineEnding);
  if (docChanged) {
    tab.syntaxIssues = tab.typeIssues = tab.extensionIssues = undefined;
    tab.version++;
    navigation.map(tab.id, changes, state.doc);
    failureLens.mapBreakpoints(tab.path, before.doc, state.doc, changes);
  }
  if (docChanged || endingChanged) {
    api.extensionDocumentChanged(tab.projectId, tab.path);
    testEvidence.changed();
    const dirty = isDirty(tab, state);
    if (dirty !== tab.dirty) {
      tab.dirty = dirty;
      if (!dirty && tab.recoveryConflict) {
        tab.recoveryConflict = false;
        tab.revision = tab.diskRevision;
      }
      syncDirty();
    }
    queueDraft(tab);
    searchPanel.changed();
  }
  if (docChanged) {
    problemsPanel.changed(tab);
    semantic.changed();
    if (tab.language) {
      referencesPanel.changed();
      symbolPicker.changed();
    }
  }
  return endingChanged;
}

function editorState(tab, text, ending) {
  const snippets = extensionContributions.source(tab.path, tab.language);
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      lineEnding.init(() => ending),
      lineEndingHistory,
      editorTheme,
      editorColorMode.of(colorModeExtension(colorMode === 'dark')),
      editorOptions.of(optionExtensions(editorSettings)),
      autocompletion({ override: tab.language ? [semanticCompletion, snippets] : [snippets] }),
      runtimeKind(tab.path) === 'javascript' ? failureLens.gutter(tab) : [],
      tab.language ? [
        javascript({ typescript: tab.language.typescript, jsx: tab.language.jsx }),
        keymap.of([indentWithTab]),
        indentGuides,
        syntaxDecorations,
        symbolInfo.extension,
        signatureHelp.extension,
      ] : [],
      EditorView.contentAttributes.of({ 'aria-label': 'Source editor' }),
      EditorView.updateListener.of(update => {
        const endingChanged = updateDocument(tab, update.startState, update.state, update.changes, update.docChanged);
        if (update.docChanged || (update.selectionSet && !update.startState.selection.eq(update.state.selection))) {
          definitionNavigation.invalidate();
        }
        if (update.docChanged || update.selectionSet || endingChanged) syncCursor();
      }),
    ],
  });
}

function selectTreeFile() {
  for (const button of tree.querySelectorAll('button[data-file]')) {
    if (active && documentKey(button.dataset.file) === documentKey(active.path)) button.setAttribute('aria-current', 'true');
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
  if (changed && active) {
    active.scroll = view.scrollSnapshot();
    semantic.changed();
    definitionNavigation.invalidate();
    closeCompletion(view);
    signatureHelp.dismiss(view);
    symbolInfo.leave(active);
  }
  active = tab;
  if (changed) typeProblems.refresh();
  layout.filePath(tab?.path);
  editor.hidden = !tab;
  byId('welcome').hidden = Boolean(tab);
  if (tab) {
    if (changed) {
      view.setState(tab.state);
      if (tab.scroll) view.dispatch({ effects: tab.scroll });
    }
    view.focus();
  }
  renderTabs();
  selectTreeFile();
  syncCommands();
  syncCursor();
}

function documentKey(path) {
  return project.caseInsensitivePaths ? path.replaceAll('\\', '/').toLowerCase() : path;
}

function findDocument(path) {
  const exact = documents.get(path);
  if (exact || !project.caseInsensitivePaths) return exact;
  const key = documentKey(path);
  return [...documents.values()].find(tab => documentKey(tab.path) === key);
}

function createTab(path, text, revision) {
  const tab = {
    id: ++documentSequence,
    version: 0,
    path,
    projectId: project.id,
    name: path.split(/[\\/]/).at(-1),
    language: sourceLanguage(path),
    revision,
    bom: text.startsWith('\uFEFF') ? '\uFEFF' : '',
    savedEol: detectLineEnding(text),
    dirty: false,
  };
  tab.state = editorState(tab, normalizeSource(text), tab.savedEol);
  tab.savedDoc = tab.state.doc;
  documents.set(path, tab);
  problemsPanel.track(tab);
  return tab;
}

async function openFile(path, expected) {
  const request = ++fileRequest;
  const openedProject = project;
  const current = () => request === fileRequest && project === openedProject && (!expected || expected.isCurrent());
  const stale = () => new Error(expected?.staleMessage ?? 'This match is out of date. Search again.');
  if (!openedProject || !current()) return null;
  let tab = findDocument(path);
  if (expected?.version !== undefined &&
      (!tab || tab.id !== expected.documentId || tab.version !== expected.version)) {
    throw stale();
  }
  if (!tab || expected?.revision) {
    let disk;
    try {
      disk = await api.read(openedProject.id, path);
    } catch (error) {
      if (!current()) return null;
      if (expected) throw stale();
      throw error;
    }
    if (!current()) return null;
    if (expected?.revision && disk.revision !== expected.revision) {
      throw stale();
    }
    if (expected?.revision && tab && ((tab.dirty && !expected.allowDraft) || tab.revision !== disk.revision)) {
      throw new Error(expected.changedMessage ?? 'The open file changed on disk. Reopen it, then search again.');
    }
    tab ??= createTab(path, disk.text, disk.revision);
  }
  if (expected?.validate && !expected.validate(tab.state.doc)) throw stale();
  showFile(tab);
  notify(tab.recoveryConflict ? 'The original changed or is unavailable. Save a recovery copy.' : tab.path,
    tab.recoveryConflict);
  return tab;
}

async function removeTab(tab) {
  if (tab.dirty || tab.draftTask || tab.draftError) {
    tab.discarding = true;
    syncCommands();
    await queueDraft(tab);
    if (tab.draftError) {
      tab.discarding = false;
      syncCommands();
      throw tab.draftError;
    }
  }
  documents.delete(tab.path);
  semantic.changed();
  problemsPanel.remove(tab);
  if (tab.language) {
    referencesPanel.changed();
    symbolPicker.changed();
  }
  if (tab.dirty) searchPanel.changed();
  if (tab === active) showFile([...documents.values()].at(-1));
  syncDirty();
}

async function closeFile(tab) {
  if (changingProject || savingAll || tab.saving || tab.discarding) return;
  const openedProject = project;
  if (tab.dirty && !await api.confirmDiscard(tab.name)) return;
  if (project !== openedProject || documents.get(tab.path) !== tab || savingAll || tab.saving || tab.discarding) return;
  editor.inert = true;
  try {
    await removeTab(tab);
  } finally {
    editor.inert = false;
    if (active) view.focus();
  }
}

async function adoptProject(next) {
  ++fileRequest;
  navigation.clear();
  searchPanel.reset();
  problemsPanel.reset();
  referencesPanel.reset();
  symbolPicker.close();
  semantic.changed();
  project = next;
  extensionManager.reset();
  changePanel.reset(next);
  terminalPanel.reset(next);
  taskPanel.reset(next);
  recipesPanel.reset(next);
  debugEntry = debugRecipe = undefined;
  failureLens.reset(next);
  flightpathPanel.reset(next);
  testEvidence.reset(next);
  documents.clear();
  expanded.clear();
  showFile(undefined);
  applyEditorSettings(next.settings.effective);
  renderTree();
  byId('project-title').textContent = project.name;
  byId('project-title').title = project.root;
  byId('welcome').querySelector('h1').textContent = 'Choose a file to edit.';
  byId('welcome-copy').textContent = 'The Explorer shows the files in this project.';
  retryAvailable = false;
  resetOutput();
  flightpathPanel.refresh();
  notify(project.root);
  let restored;
  for (const draft of next.recovered) {
    const disk = await api.read(next.id, draft.path).catch(() => null);
    if (disk?.text === draft.text) {
      await api.draft(next.id, draft.path, null).catch(report);
      continue;
    }
    const tab = createTab(draft.path, draft.text, draft.revision);
    setDiskBaseline(tab, disk);
    tab.dirty = true;
    tab.recoveryConflict = draft.revision !== disk?.revision;
    restored ??= tab;
  }
  if (restored) {
    showFile(restored);
    const count = documents.size;
    const recovered = 'Recovered ' + count + (count === 1 ? ' unsaved file.' : ' unsaved files.');
    notify(restored.recoveryConflict ? recovered + ' The original changed or is unavailable.' : recovered);
  } else if (next.entry) {
    await openFile(next.entry);
  }
  if (next.unreadable) notify('Some draft backups could not be read. The backups are still on disk.', true);
  syncDirty();
}

async function openProject(picker) {
  if (openButton.disabled) return;
  changingProject = true;
  syncCommands();
  editor.inert = true;
  try {
    const open = [...documents.values()];
    const discard = open.some(tab => tab.dirty);
    if (discard && !await api.confirmDiscard(project.name)) return;
    await Promise.all(open.map(tab => tab.draftTask));
    const next = await picker(discard);
    if (next) await adoptProject(next);
  } finally {
    editor.inert = false;
    if (active) view.focus();
    changingProject = false;
    syncCommands();
  }
}

function setDiskBaseline(tab, disk) {
  tab.savedDoc = disk ? Text.of(normalizeSource(disk.text).split('\n')) : null;
  tab.savedEol = disk ? detectLineEnding(disk.text) : undefined;
  tab.diskRevision = disk?.revision;
}

async function saveFile(tab) {
  if (!tab?.dirty || tab.discarding) return;
  if (tab.recoveryConflict) throw new Error('The original changed or is unavailable. Save a recovery copy.');
  if (tab.saving) return tab.saving;
  const task = async () => {
    if (tab.language && editorSettings?.formatOnSave) {
      const { doc } = tab.state;
      const ending = tab.state.field(lineEnding);
      const result = await api.format(tab.projectId, tab.path, doc.toString(), ending, Boolean(tab.bom));
      if (tab.state.doc !== doc || tab.state.field(lineEnding) !== ending) {
        throw new Error('The document changed while preparing the save. Save again to include the latest edits.');
      }
      applyFormatResult(tab, ending, result);
    }
    const before = tab.state;
    const revision = await api.save(tab.projectId, tab.path, serialize(tab, before), tab.revision);
    return { before, revision };
  };
  tab.saving = task();
  syncCommands();
  try {
    const { before, revision } = await tab.saving;
    tab.revision = revision;
    tab.savedDoc = before.doc;
    tab.savedEol = before.field(lineEnding);
    tab.dirty = isDirty(tab, tab.state);
    queueDraft(tab);
    searchPanel.changed();
    semantic.changed();
    if (/\.json$/i.test(tab.path)) referencesPanel.changed();
    notify('Saved ' + tab.path);
    return true;
  } catch (error) {
    if (/^This file changed on disk\./.test(errorText(error))) {
      const disk = await api.read(tab.projectId, tab.path).catch(() => null);
      setDiskBaseline(tab, disk);
      tab.recoveryConflict = true;
    }
    throw error;
  } finally {
    tab.saving = undefined;
    syncDirty();
  }
}

function saveAll() {
  if (changingProject || run || savingAll) return;
  const batch = [...documents.values()].filter(tab => tab.dirty);
  if (!batch.length) return;
  savingAll = (async () => {
    let saved = 0;
    for (const tab of batch) {
      try {
        if (await saveFile(tab)) saved++;
      } catch (error) {
        notify('Save All stopped at ' + tab.path + '. Saved ' + saved + ' of ' + batch.length + ' files. ' + errorText(error), true);
        return;
      }
    }
    notify(saved ? 'Saved ' + saved + (saved === 1 ? ' file.' : ' files.') : 'No files needed saving.');
  })().finally(() => {
    savingAll = undefined;
    syncCommands();
  });
  syncCommands();
}

async function saveRecoveredCopy(tab) {
  if (recoveryButton.disabled || !tab?.recoveryConflict) return;
  const before = tab.state;
  tab.saving = api.saveCopy(tab.projectId, tab.path, serialize(tab, before));
  syncCommands();
  try {
    const name = await tab.saving;
    project.files = await api.list(project.id, '');
    renderTree();
    if (before.doc.eq(tab.state.doc) && before.field(lineEnding) === tab.state.field(lineEnding)) {
      editor.inert = true;
      try {
        await removeTab(tab);
      } finally {
        editor.inert = false;
      }
      await openFile(name);
    }
    notify('Saved recovery copy ' + name);
  } finally {
    tab.saving = undefined;
    syncCommands();
  }
}

async function formatDocument() {
  if (formatButton.disabled) return;
  const tab = active;
  const version = tab.version;
  const ending = tab.state.field(lineEnding);
  const stillEditing = () => active === tab && !changingProject && !tab.discarding &&
    !document.body.inert && !editor.inert && documents.get(tab.path) === tab;
  const stillCurrent = () => stillEditing() && tab.version === version && tab.state.field(lineEnding) === ending;
  if (document.activeElement === formatButton) view.focus();
  tab.formatting = true;
  syncCommands();
  notify('Formatting ' + tab.path + '…');
  try {
    const result = await api.format(tab.projectId, tab.path, tab.state.doc.toString(), ending, Boolean(tab.bom));
    if (!stillCurrent()) {
      if (stillEditing()) notify('Formatting skipped because the document changed.');
      return;
    }
    if (!result.changes.length && result.eol === ending) {
      notify('No formatting changes for ' + tab.path);
      return;
    }
    applyFormatResult(tab, ending, result);
    notify('Formatted ' + tab.path);
  } catch (error) {
    if (stillCurrent()) report(error);
    else if (stillEditing()) notify('Formatting skipped because the document changed.');
  } finally {
    tab.formatting = false;
    syncCommands();
  }
}

function applyFormatResult(tab, ending, result) {
  if (!result.changes.length && result.eol === ending) return;
  const changes = tab.state.changes(result.changes);
  const transaction = tab.state.update({
    changes,
    selection: tab.state.selection.map(changes, 1),
    effects: result.eol === ending ? [] : [changeLineEnding.of(result.eol)],
    annotations: isolateHistory.of('full'),
    scrollIntoView: tab === active && view.hasFocus,
    userEvent: 'input.format',
  });
  if (tab === active) view.dispatch(transaction);
  else updateDocument(tab, transaction.startState, transaction.state, transaction.changes, transaction.docChanged);
}

function setRunState(text, state = '') {
  const badge = byId('run-state');
  badge.textContent = text;
  badge.dataset.state = state;
}

function renderTestPass(evidence, checking) {
  if (!evidence || !testPass || evidence.id !== testPass.id) return;
  if (checking) setRunState('Pass · checking inputs');
  else if (evidence.freshness === 'historical') setRunState('Historical pass · ' + testPass.elapsed);
  else if (evidence.freshness === 'unavailable') setRunState('Pass · revision unavailable');
  else setRunState((evidence.retry ? 'Passed · retry only · ' : 'Passed · ') + testPass.elapsed, 'ok');
}

function showDock(name, focus = false) {
  dock.dataset.pane = name;
  for (const [pane, button] of Object.entries(dockButtons)) button.setAttribute('aria-pressed', String(pane === name));
  byId('problems-panel').hidden = byId('problems-status').hidden = name !== 'problems';
  byId('references-panel').hidden = name !== 'references';
  layout.expandDock();
  terminalPanel.show(name === 'terminal', focus);
  flightpathPanel.show(name === 'flightpath');
  taskPanel.show(name === 'tasks');
  recipesPanel.show(name === 'recipes');
  failureLens.show(name === 'failure');
  changePanel.show(name === 'changes');
  problemsPanel.render();
  if (name === 'problems') void extensionManager.refresh();
  if (focus && name !== 'terminal') dockButtons[name].focus();
}

async function applyGitAction(action, details) {
  if (!project || changingGit || changingProject || run) throw new Error('Wait for the current workspace action to finish.');
  const scope = project;
  changingGit = true;
  editor.inert = true;
  syncCommands();
  try {
    await Promise.all([...documents.values()].map(tab => tab.draftTask));
    const result = await api.gitWrite(scope.id, action, details);
    if (result?.switched && project === scope) {
      const files = await api.list(scope.id, '');
      await adoptProject({ ...scope, files, recovered: [], entry: undefined, unreadable: false });
    }
    return result;
  } finally {
    changingGit = false;
    editor.inert = false;
    syncCommands();
  }
}

async function updateRecipeFile(action, revision) {
  const tab = findDocument(recipeFile);
  if (tab?.dirty) throw new Error('Save or close the edited recipe file before upgrading.');
  changingProject = true;
  editor.inert = true;
  syncCommands();
  try {
    const scope = project;
    await tab?.draftTask;
    const file = await api.recipeFile(scope.id, action, revision);
    testEvidence.changed();
    searchPanel.changed();
    scope.files = await api.list(scope.id, '');
    renderTree();
    if (tab) await removeTab(tab);
    await openFile(file);
  } finally {
    changingProject = false;
    editor.inert = false;
    syncCommands();
  }
}

function resetOutput(target = '', mode = 'file', plan = []) {
  testPass = undefined;
  const testing = mode === 'tests';
  const tasks = mode === 'tasks';
  const recipe = mode === 'recipe';
  const debug = mode === 'debug';
  dock.dataset.mode = mode;
  if (testing || tasks || recipe) testEvidence.clear();
  taskPanel.start(plan);
  byId('run-heading').textContent = testing ? 'Test results' : tasks ? 'Task output' :
    recipe ? 'Recipe output' : debug ? 'Debug output' : 'Run output';
  byId('test-results').hidden = !testing;
  byId('test-empty').hidden = false;
  byId('test-empty').textContent = 'Waiting for test results…';
  byId('test-totals').hidden = true;
  failureList.replaceChildren();
  diagnostic = undefined;
  byId('run-diagnostic').hidden = true;
  byId('run-target').textContent = target;
  outputText = '';
  outputNotice.hidden = true;
  failureLens.begin(debug);
  output.classList.remove('has-output');
  output.setAttribute('aria-label', testing ? 'Test output' : tasks ? 'Task output' : recipe ? 'Recipe output' : 'Program output');
  output.textContent = testing ? 'Waiting for test output…' :
    tasks ? 'Waiting for task output…' : recipe ? 'Waiting for recipe output…' :
    target ? 'Waiting for program output…' : 'Run a JavaScript file to see its output here.';
  setRunState('Ready');
}

function appendOutput(text, { replace = false, truncated = false } = {}) {
  if (!text && !replace) return;
  const follow = output.scrollHeight - output.clientHeight - output.scrollTop <= 24;
  const combined = replace ? text : outputText + text;
  if (replace) outputNotice.hidden = !truncated;
  if (truncated || combined.length > maxOutput) outputNotice.hidden = false;
  outputText = combined.slice(-maxOutput);
  output.textContent = outputText;
  failureLens.output(outputText, !outputNotice.hidden);
  output.classList.add('has-output');
  if (follow) output.scrollTop = output.scrollHeight;
}

function watchOutput(attempt) {
  let cursor = 0;
  async function read() {
    if (run !== attempt) return;
    try {
      const batch = await api.runOutput(attempt.workspaceId, attempt.id, attempt.sessionId, cursor);
      if (run !== attempt) return;
      if (batch) {
        cursor = batch.cursor;
        appendOutput(batch.text, { replace: batch.reset, truncated: batch.truncated });
      }
    } catch (error) {
      if (run === attempt) report(error);
      return;
    }
    attempt.outputTimer = setTimeout(read, 50);
  }
  attempt.outputTimer = setTimeout(read, 50);
}

function cancelBeforeStart(attempt) {
  run = undefined;
  setRunState('Canceled');
  output.textContent = 'Execution canceled.';
  if (attempt.mode === 'tests') byId('test-empty').textContent = 'Execution canceled.';
  if (attempt.mode === 'tasks' || attempt.mode === 'recipe') taskPanel.blockWaiting('Run canceled');
  failureLens.exit({ stopped: true });
  syncCommands();
}

async function launchRun(mode, target, prepare, start, plan, authorize = attempt => api.authorizeRun(attempt.workspaceId, attempt.id)) {
  const attempt = { id: ++runSequence, workspaceId: project.id, mode, stage: 'starting' };
  run = attempt;
  showDock(mode === 'debug' ? 'failure' : 'output');
  resetOutput(target, mode, plan);
  setRunState('Starting', 'running');
  syncCommands();
  try {
    const token = await authorize(attempt);
    if (!token) return cancelBeforeStart(attempt);
    attempt.sessionId = token;
    if (attempt.stage === 'stopping') return cancelBeforeStart(attempt);
    await prepare(attempt);
    if (attempt.stage === 'stopping') return cancelBeforeStart(attempt);
    attempt.submitted = true;
    const admission = start(attempt);
    watchOutput(attempt);
    await admission;
    if (run === attempt && attempt.stage !== 'stopping') {
      attempt.stage = 'running';
      setRunState('Running', 'running');
      syncCommands();
    }
  } catch (error) {
    if (run !== attempt) return;
    clearTimeout(attempt.outputTimer);
    if (attempt.stage === 'stopping' && !attempt.submitted) return cancelBeforeStart(attempt);
    run = undefined;
    setRunState('Could not run', 'error');
    if (mode === 'tests') byId('test-empty').textContent = 'The tests could not start.';
    if (mode === 'tasks' || mode === 'recipe') taskPanel.blockWaiting('Execution could not start');
    appendOutput(errorText(error));
    failureLens.exit({ error: errorText(error) });
    syncCommands();
    report(error);
  } finally {
    if (attempt.sessionId && !attempt.submitted) {
      void api.stop(attempt.workspaceId, attempt.id, attempt.sessionId).catch(() => {});
    }
  }
}

function runFile() {
  if (runButton.disabled) return;
  const tab = active;
  const language = runtimeKind(tab.path);
  const profile = runtimePanel.profile(language);
  if (language === 'python' && !profile) {
    showDock('output');
    runtimePanel.focusPython();
    notify('Choose a Python interpreter before running this file.');
    return;
  }
  return launchRun('file', tab.path, async () => {
    await saveFile(tab);
    if (tab.dirty) throw new Error('The file changed during save. Run it again to include the latest edits.');
  }, attempt => api.start(attempt.workspaceId, tab.path, tab.revision, attempt.id, attempt.sessionId, profile));
}

function redrawDebugGutter() {
  if (runtimeKind(active?.path) === 'javascript') view.dispatch({ effects: refreshDebugGutter.of(null) });
}

function runDebug(tab = active) {
  if (!tab || runtimeKind(tab.path) !== 'javascript' || run || changingProject || changingGit || savingAll ||
      [...documents.values()].some(item => item.saving || item.discarding)) return;
  debugEntry = tab.path;
  debugRecipe = undefined;
  return launchRun('debug', tab.path, prepareWorkspaceRun,
    attempt => api.debugStart(attempt.workspaceId, tab.path, tab.revision, attempt.id, attempt.sessionId, failureLens.requestBreakpoints()));
}

async function restartDebug() {
  const file = debugEntry;
  if (!file || changingProject) return;
  if (run?.mode === 'debug' && run.stage !== 'stopping') {
    run.restart = true;
    await stopRun();
  } else if (!run) {
    if (debugRecipe) return runRecipe(debugRecipe);
    const current = project;
    const tab = await openFile(file);
    if (project === current && tab && !run) void runDebug(tab);
  }
}

function sendDebugCommand(action, pauseId, frame) {
  const attempt = run;
  if (attempt?.mode !== 'debug' || !attempt.sessionId || attempt.stage === 'stopping') throw new Error('The debug session has ended.');
  return api.debugCommand(attempt.workspaceId, attempt.id, attempt.sessionId, action, pauseId, frame);
}

function jumpToDebugSource(anchor, isCurrent) {
  jumpToRecordedSource(anchor, isCurrent, 'The recorded debug source changed or is unavailable. Restart debugging to refresh this location.');
}

async function prepareWorkspaceRun(attempt) {
  for (const tab of documents.values()) {
    if (attempt.stage === 'stopping') return;
    await saveFile(tab);
  }
  if ([...documents.values()].some(tab => tab.dirty)) {
    throw new Error('An open file changed during save. Try again to include the latest edits.');
  }
  attempt.sourceVersion = testEvidence.version;
}

function runTests(retry = false) {
  if (testButton.disabled || (retry && !retryAvailable)) return;
  const goal = testEvidence.goal;
  return launchRun('tests', retry ? 'Failed tests' : 'Project tests', prepareWorkspaceRun,
    attempt => api.test(attempt.workspaceId, retry, attempt.id, attempt.sessionId, goal));
}

function runTask(target, revision, plan) {
  return launchRun('tasks', 'Task Weave · ' + plan.at(-1).id, prepareWorkspaceRun,
    attempt => api.runTask(attempt.workspaceId, target, revision, attempt.id, attempt.sessionId), plan);
}

function runRecipe(plan) {
  if (!project || run || changingProject || changingGit || savingAll ||
      [...documents.values()].some(tab => tab.saving || tab.discarding)) return;
  if (findDocument(recipeFile)?.dirty) {
    notify('Save the recipe file and refresh Recipes before running.', true);
    return;
  }
  const debugging = Boolean(plan.entry);
  const goal = testEvidence.goal;
  if (debugging) {
    debugEntry = plan.entry;
    debugRecipe = plan;
  }
  return launchRun(debugging ? 'debug' : 'recipe', 'Recipe · ' + plan.name, prepareWorkspaceRun,
    attempt => {
      if (plan.preview.some(step => step.kind === 'test')) retryAvailable = false;
      return api.recipeStart(attempt.workspaceId, attempt.id, attempt.sessionId,
        debugging ? failureLens.requestBreakpoints() : [], goal);
    }, debugging ? [] : plan.preview,
    attempt => api.authorizeRecipe(attempt.workspaceId, attempt.id, plan.id, plan.digest));
}

async function stopRun() {
  const attempt = run;
  if (!attempt || attempt.stage === 'stopping') return;
  attempt.stage = 'stopping';
  if (attempt.mode === 'debug') failureLens.stopping();
  setRunState('Stopping');
  syncCommands();
  if (attempt.sessionId) await api.stop(attempt.workspaceId, attempt.id, attempt.sessionId);
}

function locationLabel({ path, line, column }) {
  return `${path}:${line}:${column}`;
}

function jumpToTaskSource(anchor, isCurrent) {
  jumpToRecordedSource(anchor, isCurrent, 'The recorded task source changed or is unavailable. Run the task again to refresh this location.');
}

function jumpToRecordedSource(anchor, isCurrent, staleMessage) {
  void jumpToLocation(anchor, {
    revision: anchor.revision, isCurrent, staleMessage, changedMessage: staleMessage,
    validate: doc => anchor.line <= doc.lines && anchor.column <= doc.line(anchor.line).length + 1,
  }).catch(error => { if (isCurrent()) report(error); });
}

function appendFailure({ name, message, location, anchor }, evidenceId) {
  byId('test-empty').hidden = true;
  const item = document.createElement('li');
  const row = document.createElement(anchor ? 'button' : 'div');
  row.className = 'test-result';
  const title = label(name);
  const detail = label(message);
  title.title = name;
  detail.title = message;
  row.append(title, detail);
  if (location) {
    const source = label(locationLabel(location) + (anchor ? '' : ' · Source revision unavailable'));
    source.className = 'test-source';
    source.title = source.textContent;
    row.append(source);
  }
  if (anchor) {
    const isCurrent = () => testEvidence.isCurrent(evidenceId);
    const staleMessage = 'The recorded test source changed or is unavailable. Run tests again to refresh this location.';
    row.onclick = () => jumpToLocation(anchor, {
      revision: anchor.revision, isCurrent, staleMessage, changedMessage: staleMessage,
      validate: doc => anchor.line <= doc.lines && anchor.column <= doc.line(anchor.line).length + 1,
    }).catch(error => {
      if (isCurrent()) {
        report(error);
        void testEvidence.recheck();
      }
    });
  }
  item.append(row);
  failureList.append(item);
}

function finishTests(event, elapsed) {
  const { counts } = event;
  retryAvailable = event.retryAvailable;
  const empty = byId('test-empty');
  if (counts) {
    const totals = byId('test-totals');
    totals.textContent = [
      `${counts.passed - counts.cached} passed`, `${counts.failed} failed`,
      counts.cached && `${counts.cached} already passed`,
      counts.skipped && `${counts.skipped} skipped`,
      counts.todo && `${counts.todo} todo`,
      counts.cancelled && `${counts.cancelled} cancelled`,
    ].filter(Boolean).join(' · ');
    totals.title = totals.textContent;
    totals.hidden = counts.tests === 0;
    if (counts.omitted) {
      const remaining = document.createElement('li');
      remaining.className = 'test-empty';
      remaining.textContent = `${counts.omitted} more failures in the test output.`;
      failureList.append(remaining);
    }
  }

  if (event.stopped) {
    setRunState('Canceled');
    empty.textContent = 'The test run was canceled.';
  } else if (event.code === 0 && counts?.tests === 0) {
    setRunState('No tests');
    empty.textContent = 'No JavaScript tests were discovered in this project.';
  } else if (event.code === 0 && counts) {
    const evidence = testEvidence.latest;
    if (evidence) {
      testPass = { id: evidence.id, elapsed };
      renderTestPass(evidence);
    } else setRunState('Pass · revision unavailable');
    empty.textContent = 'No test failures.';
  } else {
    setRunState('Failed · ' + (counts ? elapsed : event.code ?? 'launch'), 'error');
    empty.textContent = 'See test output for details.';
  }
  if (event.error) appendOutput(event.error);
  if (!outputText) output.textContent = 'The tests produced no output.';
}

api.onRun(event => {
  if (event.workspaceId !== project?.id || event.runId !== run?.id ||
      event.sessionId !== run?.sessionId) return;
  if (event.type === 'task-progress' && (run.mode === 'tasks' || run.mode === 'recipe')) taskPanel.progress(event);
  if (event.type === 'debug-state' && run.mode === 'debug') failureLens.state(event);
  if (event.type === 'debug-breakpoint' && run.mode === 'debug') failureLens.verified(event);
  if (event.type !== 'exit') return;
  const { mode, sourceVersion, restart } = run;
  clearTimeout(run.outputTimer);
  run = undefined;
  if (event.output?.text) appendOutput(event.output.text, { replace: true, truncated: event.output.truncated });
  failureLens.exit(event);
  const elapsed = event.elapsed < 1000 ? `${event.elapsed} ms` : `${(event.elapsed / 1000).toFixed(1)} s`;
  if (mode === 'tests') {
    testEvidence.finish(event.evidence, sourceVersion);
    for (const failure of event.failures ?? []) appendFailure(failure, event.evidence?.id);
    finishTests(event, elapsed);
    flightpathPanel.refresh();
    syncCommands();
    return;
  }
  if (event.location) {
    diagnostic = event.location;
    diagnosticButton.querySelector('span').textContent = locationLabel(diagnostic);
    const summary = byId('run-error-summary');
    summary.textContent = summary.title = event.summary ?? '';
    byId('run-diagnostic').hidden = false;
  }
  if (mode === 'tasks' || mode === 'recipe') {
    testEvidence.finish(event.evidence, sourceVersion);
    if (event.stopped) setRunState('Canceled');
    else if (event.code === 0) setRunState('Completed · ' + elapsed);
    else setRunState(event.completedWithFailures && mode === 'tasks' ? 'Completed with failures' :
      mode === 'recipe' ? 'Recipe failed' : 'Task failed', 'error');
    if (event.error) appendOutput(event.error);
    if (!outputText) output.textContent = mode === 'recipe' ? 'The recipe produced no output.' : 'The tasks produced no output.';
    taskPanel.blockWaiting(event.stopped ? 'Run canceled' : 'Execution could not continue');
    flightpathPanel.refresh();
    syncCommands();
    return;
  }
  if (event.stopped) setRunState('Canceled');
  else if (event.code === 0) setRunState('Passed · ' + elapsed, 'ok');
  else setRunState(`Failed · ${event.code ?? event.signal ?? 'launch'}`, 'error');
  if (event.error) appendOutput(event.error);
  if (!outputText) output.textContent = 'The program produced no output.';
  syncCommands();
  if (restart) void restartDebug().catch(report);
});

function documentPosition(line, column) {
  const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
  return Math.max(target.from, Math.min(target.from + column - 1, target.to));
}

function captureLocation() {
  if (!active) return null;
  const selection = view.state.selection;
  const line = view.state.doc.lineAt(selection.main.head);
  return {
    path: active.path, documentId: active.id, selection, scroll: view.scrollSnapshot(),
    line: line.number, column: selection.main.head - line.from + 1,
  };
}

async function jumpToLocation({ path, line, column, offset, length = 0 }, expected) {
  const origin = captureLocation();
  const tab = await openFile(path, expected);
  if (!tab) return;
  const pos = offset ?? documentPosition(line, column);
  const end = Math.min(view.state.doc.length, pos + length);
  if (origin?.documentId !== tab.id || origin?.selection.main.head !== pos) {
    navigation.record(origin);
  }
  view.dispatch({
    selection: { anchor: end, head: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  view.focus();
  if (tab.dirty && !expected) notify('The source location refers to the saved version of this file.');
  syncCommands();
}

async function travel(direction) {
  const destination = navigation.peek(direction);
  if (!destination || navigating || changingProject) return;
  const origin = captureLocation();
  navigating = true;
  syncCommands();
  try {
    const tab = await openFile(destination.path);
    if (!tab) return;
    const sameDocument = tab.id === destination.documentId;
    const pos = documentPosition(destination.line, destination.column);
    const selection = sameDocument ? destination.selection : { anchor: pos };
    const effects = (sameDocument && destination.scroll) || EditorView.scrollIntoView(pos, { y: 'center' });
    navigation.complete(direction, origin);
    view.dispatch({ selection, effects });
    view.focus();
  } catch (error) {
    navigation.discard(direction, destination);
    throw error;
  } finally {
    navigating = false;
    syncCommands();
  }
}

const searchPanel = createSearchPanel({
  api,
  getProject: () => project,
  getSnapshots: () => [...documents.values()].filter(tab => tab.dirty).map(tab => ({
    path: tab.path, documentId: tab.id, version: tab.version, text: tab.state.doc.toString(),
  })),
  jump: jumpToLocation,
  previewReplace: (result, replacement) => editPreview.replace(result, replacement),
  errorText,
});

const problemsPanel = createProblemsPanel({
  api,
  apply(tab, issues) {
    tab.syntaxIssues = issues;
    showDiagnostics(tab);
  },
  jump: jumpToLocation,
  report,
  errorText,
});

const getActive = () => active;
const semantic = createSemanticContext({
  api,
  getActive,
  getDocuments: () => documents.values(),
  available: () => !changingProject && !document.body.inert && !editor.inert,
  onChanged: () => typeProblems.refresh(),
});
function showDiagnostics(tab) {
  if (documents.get(tab.path) !== tab) return;
  const update = setDiagnostics(tab.state, [...(tab.syntaxIssues ?? []), ...(tab.typeIssues ?? []), ...(tab.extensionIssues ?? [])]);
  if (tab === active) view.dispatch(update);
  else tab.state = tab.state.update(update).state;
}

const typeProblems = createTypeProblems({
  getActive,
  check: tab => semantic.typeCheck(tab),
  apply(tab, issues) {
    if (!issues.length && !tab.typeIssues?.length) return;
    tab.typeIssues = issues;
    showDiagnostics(tab);
  },
  jump: jumpToLocation,
  report,
  errorText,
});
const symbolInfo = createSymbolInfo({ semantic, getActive, notify, report });
const semanticCompletion = createSemanticCompletion({ semantic, getActive, report });
const signatureHelp = createSignatureHelp({ semantic, getActive, notify, report });
const definitionNavigation = createDefinitionNavigation({
  semantic, getActive, getFileRequest: () => fileRequest, jump: jumpToLocation, notify, report,
});
const referencesPanel = createReferencesPanel({
  api, semantic, getActive, show: () => showDock('references'), jump: jumpToLocation, errorText,
});
const symbolPicker = createSymbolPicker({ api, semantic, getProject: () => project, jump: jumpToLocation, report, errorText });

function applyEditorSettings(settings) {
  editorSettings = settings;
  const fonts = { default: 'var(--mono)', consolas: 'Consolas, monospace', courier: '"Courier New", monospace' };
  editor.style.setProperty('--editor-font', fonts[settings.fontFamily]);
  editor.style.setProperty('--editor-font-size', settings.fontSize + 'px');
  editor.style.setProperty('--editor-cursor-width', settings.cursor === 'wide' ? '3px' : '1px');
  editor.dataset.lineNumbers = String(settings.lineNumbers);
  renameButton.title = 'Rename Symbol (' + (settings.renameShortcut === 'f2' ? 'F2' : 'Ctrl+Alt+R') + ')';
  const effects = editorOptions.reconfigure(optionExtensions(settings));
  for (const tab of documents.values()) {
    if (tab === active) view.dispatch({ effects });
    else tab.state = tab.state.update({ effects }).state;
  }
}

const settingsDialog = createEditorSettings({
  api, getProject: () => project, apply: applyEditorSettings, errorText,
});

function openSettings() {
  if (!settingsButton.disabled) void settingsDialog.show();
}

const staleEdits = path => new Error('The source changed. Refresh the preview for ' + path);

const editPreview = createEditPreview({
  errorText,
  async prepare({ files, skipped, authority }, replacement) {
    if (!project || changingProject || run || files.length > 64) throw new Error('Preview at most 64 files at a time.');
    const workspace = project;
    const changes = [];
    const encoder = new TextEncoder();
    let bytes = 0;
    for (const file of files) {
      const tab = findDocument(file.path);
      const doc = tab?.state.doc;
      const version = tab?.version;
      const ending = tab?.state.field(lineEnding);
      const path = tab?.path ?? file.path;
      const disk = await api.read(workspace.id, path);
      bytes += encoder.encode(disk.text).byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('Narrow the preview to at most 16 MiB of source.');
      if (project !== workspace || findDocument(path) !== tab || tab?.version !== version ||
          tab?.state.field(lineEnding) !== ending || tab?.recoveryConflict || tab?.saving || tab?.discarding ||
          (tab && tab.revision !== disk.revision) ||
          (file.documentId === undefined ? file.revision !== disk.revision || tab?.dirty :
            tab?.id !== file.documentId || version !== file.version)) throw staleEdits(path);
      const original = doc ?? Text.of(normalizeSource(disk.text).split('\n'));
      const eol = ending ?? detectLineEnding(disk.text);
      if (new Set(disk.text.match(/\r\n|\r|\n/g)).size > 1) {
        throw new Error('Normalize mixed line endings before applying a batch to ' + path);
      }
      const edits = file.matches.map(match => {
        const from = match.offset ?? original.line(match.line).from + match.column - 1;
        return { from, to: from + match.length, insert: match.replacement ?? replacement };
      }).sort((a, b) => a.from - b.from);
      let end = 0;
      for (const edit of edits) {
        if (edit.from < end || edit.to < edit.from || edit.to > original.length || typeof edit.insert !== 'string') {
          throw new Error('Invalid edit range in ' + path);
        }
        end = edit.to;
      }
      const changed = edits.filter(edit => original.sliceString(edit.from, edit.to) !== edit.insert);
      if (changed.length) changes.push({ path, tab, version, eol, disk, doc: original, edits: changed });
    }
    return { workspace, changes, skipped, authority };
  },
  stage(prepared, verify) {
    stagingEdits = stageEdits(prepared, verify).finally(() => { stagingEdits = undefined; });
    return stagingEdits;
  },
});

async function stageEdits({ workspace, changes, authority }, verify) {
  if (project !== workspace || changingProject || run) throw new Error('The workspace is busy or has changed.');
  ++fileRequest;
  definitionNavigation.invalidate();
  await verify?.();
  await Promise.all(changes.map(({ tab }) => tab?.draftTask));
  const staged = changes.map(file => {
    const { path, tab, disk, doc, eol, version, edits } = file;
    if (findDocument(path) !== tab || tab?.version !== version ||
        (tab && (tab.state.doc !== doc || tab.state.field(lineEnding) !== eol || tab.revision !== disk.revision ||
          tab.recoveryConflict || tab.saving || tab.discarding || tab.formatting))) throw staleEdits(path);
    const state = tab?.state ?? EditorState.create({ doc });
    const modified = state.changes(edits).apply(doc);
    const bom = tab?.bom ?? (disk.text.startsWith('\uFEFF') ? '\uFEFF' : '');
    return { path, text: bom + modified.toString().replaceAll('\n', eol), revision: disk.revision };
  });
  await api.stageEdits(workspace.id, staged, authority);
  let first;
  for (const file of changes) {
    const tab = file.tab ?? createTab(file.path, file.disk.text, file.disk.revision);
    const transaction = tab.state.update({ changes: file.edits, annotations: isolateHistory.of('full') });
    if (tab === active) view.dispatch(transaction);
    else updateDocument(tab, transaction.startState, transaction.state, transaction.changes, true);
    first ??= tab;
  }
  showFile(active ?? first);
  notify('Created recoverable drafts in ' + changes.length + (changes.length === 1 ? ' file.' : ' files.'));
}

api.onExtensionEditorSnapshot(({ workspaceId, path, allowedFiles }) => {
  if (project?.id !== workspaceId || changingProject) return null;
  const tab = path ? findDocument(path) : active;
  if (!tab || tab.recoveryConflict || tab.saving || tab.discarding || tab.formatting) return null;
  if (allowedFiles && !allowedFiles.some(file => documentKey(file) === documentKey(tab.path))) return null;
  const selection = tab.state.selection.main;
  return { path: tab.path.replaceAll('\\', '/'), text: serialize(tab), baseRevision: tab.revision,
    documentId: tab.id, version: tab.version, selection: { from: selection.from, to: selection.to } };
});

let renderedExtensionDiagnostics;
const extensionManager = createExtensionManager({ api, getProject: () => project, report, errorText,
  async review(extensionId, proposalId) {
    editPreview.extension(async () => {
      const proposal = await api.extensionProposal(project.id, extensionId, proposalId);
      return { authority: { extensionId, proposalId }, files: [{
        path: proposal.path, revision: proposal.revision, documentId: proposal.documentId, version: proposal.version,
        matches: [{ offset: 0, length: proposal.original.length, replacement: proposal.proposedText }],
      }] };
    });
  },
  async diagnostics(sessions, current) {
    const workspace = project;
    const entries = [];
    const issues = new Map();
    for (const session of sessions) {
      for (const diagnostic of session.diagnostics) {
        const disk = await api.read(project.id, diagnostic.path).catch(() => null);
        if (!current()) return;
        if (!disk || disk.revision !== diagnostic.revision) continue;
        const tab = findDocument(diagnostic.path);
        let doc;
        if (tab) {
          if (diagnostic.documentId === undefined ? tab.dirty || tab.revision !== diagnostic.revision :
            tab.id !== diagnostic.documentId || tab.version !== diagnostic.version) continue;
          doc = tab.state.doc;
          const previous = issues.get(tab);
          const items = diagnostic.items.map(item => ({ ...item, source: session.id }));
          issues.set(tab, { doc, items: previous?.doc === doc ? previous.items.concat(items) : items });
        } else {
          if (diagnostic.documentId !== undefined) continue;
          doc = Text.of(normalizeSource(disk.text).split('\n'));
        }
        entries.push({ extensionId: session.id, tab: { path: diagnostic.path, state: { doc } }, items: diagnostic.items,
          expected: { revision: diagnostic.revision, documentId: diagnostic.documentId, version: diagnostic.version,
            allowDraft: diagnostic.documentId !== undefined,
            isCurrent: () => project === workspace && renderedExtensionDiagnostics === entries &&
              (!tab || (findDocument(diagnostic.path) === tab && tab.state.doc === doc)) } });
      }
    }
    if (!current()) return;
    for (const tab of documents.values()) {
      if (!tab.extensionIssues?.length && !issues.has(tab)) continue;
      const entry = issues.get(tab);
      tab.extensionIssues = entry?.doc === tab.state.doc ? entry.items : undefined;
      if (tab.language) showDiagnostics(tab);
    }
    renderedExtensionDiagnostics = entries;
    problemsPanel.setExtensions(entries);
  },
});

function renameSymbol() {
  if (renameButton.disabled || !semantic.available()) return;
  const tab = active;
  const position = view.state.selection.main.head;
  const version = tab.version;
  editPreview.rename(async name => {
    if (tab !== active || tab.version !== version) throw staleEdits(tab.path);
    const query = semantic.query('rename', tab, position, name);
    const files = await query.result;
    if (!query.current()) throw staleEdits(tab.path);
    return files;
  });
}

for (const [pane, button] of Object.entries(dockButtons)) button.onclick = () => showDock(pane, pane === 'terminal');
backButton.onclick = () => travel('back').catch(report);
forwardButton.onclick = () => travel('forward').catch(report);
openButton.onclick = welcomeOpen.onclick = () => openProject(api.chooseFolder).catch(report);
exampleButton.onclick = () => openProject(api.openExample).catch(report);
saveButton.onclick = () => saveFile(active).catch(report);
formatButton.onclick = formatDocument;
inspectButton.onclick = () => {
  view.focus();
  void symbolInfo.inspect(view);
};
definitionButton.onclick = () => {
  view.focus();
  void definitionNavigation.go(view);
};
symbolButton.onclick = symbolPicker.open;
findReferencesButton.onclick = () => {
  view.focus();
  void referencesPanel.find(view);
};
renameButton.onclick = renameSymbol;
settingsButton.onclick = openSettings;
recoveryButton.onclick = () => saveRecoveredCopy(active).catch(report);
runButton.onclick = runFile;
testButton.onclick = () => runTests();
retryButton.onclick = () => runTests(true);
stopButton.onclick = () => stopRun().catch(report);
diagnosticButton.onclick = () => {
  const target = diagnostic;
  if (target?.revision) jumpToRecordedSource(target, () => diagnostic === target,
    'The recorded runtime source changed or is unavailable. Run the file again to refresh this location.');
  else if (target) void jumpToLocation(target).catch(report);
};

api.beforeClose(async () => {
  document.body.inert = true;
  try {
    await stagingEdits?.catch(() => {});
    await savingAll;
    const open = [...documents.values()];
    await Promise.allSettled(open.map(tab => tab.saving));
    await Promise.all(open.map(tab => tab.draftError ? queueDraft(tab) : tab.draftTask));
    await api.closeReady(open.some(tab => tab.dirty), open.some(tab => tab.draftError));
  } catch (error) {
    document.body.inert = false;
    report(error);
  }
});

api.onCloseCanceled(() => {
  document.body.inert = false;
  if (active) view.focus();
});

async function initialize() {
  syncCommands();
  try {
    const { theme, mode } = await api.appearance();
    themeChoice.value = selectedTheme = theme;
    applyColorMode(mode);
    await extensionContributions.refresh();
    const initial = await api.initial();
    if (initial.project) await adoptProject(initial.project);
    else applyEditorSettings((await api.editorSettings()).effective);
    if (initial.unavailable) notify('A draft workspace is unavailable. Reopen it when it is accessible.', true);
    else if (initial.unreadable) notify('Some draft backups could not be read. The backups are still on disk.', true);
  } catch (error) {
    report(error);
  } finally {
    changingProject = false;
    themeChoice.disabled = false;
    api.ready();
    syncCommands();
  }
}

document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  const command = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (command && !event.shiftKey && !event.altKey && event.code === 'Backquote' && !dockButtons.terminal.disabled) {
    event.preventDefault();
    if (!event.repeat) showDock('terminal', true);
    return;
  }
  if (terminalPanel.handles(event)) return;
  if (event.key === 'F6' && view.hasFocus && runtimeKind(active?.path) === 'javascript') {
    event.preventDefault();
    if (!event.repeat) void runDebug();
  } else if (event.key === 'F9' && view.hasFocus && runtimeKind(active?.path) === 'javascript') {
    event.preventDefault();
    if (!event.repeat) failureLens.toggle(active.path, view.state.doc.lineAt(view.state.selection.main.head).number);
  } else if (event.key === 'F5') {
    event.preventDefault();
    if (run?.mode === 'debug' && failureLens.phase === 'paused') void failureLens.action('resume');
    else void runFile();
  } else if (view.hasFocus && (editorSettings?.renameShortcut === 'ctrl-alt-r' ?
    command && event.altKey && !event.shiftKey && key === 'r' : event.key === 'F2' && !command && !event.altKey && !event.shiftKey)) {
    event.preventDefault();
    if (!event.repeat) renameSymbol();
  } else if (event.key === 'F12' && view.hasFocus) {
    event.preventDefault();
    if (!event.repeat) {
      if (event.shiftKey) void referencesPanel.find(view);
      else void definitionNavigation.go(view);
    }
  } else if (command && event.altKey && key === 'i') {
    event.preventDefault();
    void symbolInfo.inspect(view);
  } else if (event.key === 'Escape' && view.hasFocus && symbolInfo.dismiss(view)) {
    event.preventDefault();
  } else if (!command && event.altKey && event.shiftKey && key === 'f') {
    event.preventDefault();
    void formatDocument();
  } else if (command && event.shiftKey && key === 'f') {
    event.preventDefault();
    layout.showSidebar();
    searchPanel.show();
  } else if (command && event.shiftKey && key === 'm') {
    event.preventDefault();
    showDock('problems', true);
  } else if (!command && event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    travel(event.key === 'ArrowLeft' ? 'back' : 'forward').catch(report);
  } else if (command && event.altKey && key === 't') {
    event.preventDefault();
    void runTests();
  } else if (command && !event.altKey && !event.shiftKey && key === 't') {
    event.preventDefault();
    if (!event.repeat) symbolPicker.open();
  } else if (command && !event.altKey && !event.shiftKey && key === 'b') {
    event.preventDefault();
    if (!event.repeat) layout.toggleSidebar();
  } else if (command && !event.altKey && !event.shiftKey && key === 'j') {
    event.preventDefault();
    if (!event.repeat) layout.toggleDock();
  } else if (command && !event.altKey && !event.shiftKey && key === ',') {
    event.preventDefault();
    if (!event.repeat) openSettings();
  } else if (command && key === 'o') {
    event.preventDefault();
    openProject(api.chooseFolder).catch(report);
  } else if (command && key === 's') {
    event.preventDefault();
    if (changingGit) return;
    if (event.shiftKey) saveAll();
    else if (!changingProject) saveFile(active).catch(report);
  } else if (command && key === 'w' && active) {
    event.preventDefault();
    closeFile(active).catch(report);
  }
}, { capture: true });

void initialize();
