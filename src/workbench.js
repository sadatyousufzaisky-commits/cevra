import { basicSetup } from 'codemirror';
import { autocompletion, closeCompletion } from '@codemirror/autocomplete';
import { addCursorAbove, addCursorBelow, indentWithTab, isolateHistory, redo, redoDepth, toggleLineComment,
  undo, undoDepth } from '@codemirror/commands';
import { foldCode, unfoldCode } from '@codemirror/language';
import { gotoLine, openSearchPanel, selectNextOccurrence } from '@codemirror/search';
import { EditorState, Text } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { linter, lintGutter, setDiagnostics, setDiagnosticsEffect } from '@codemirror/lint';
import { createDefinitionNavigation } from './definition-navigation.js';
import { createEditPreview } from './edit-preview.js';
import { editorOptions, optionExtensions } from './editor-settings.js';
import { createSettingsCenter } from './settings-center.js';
import { defaultTheme } from './settings-schema.cjs';
import { createEditorReview } from './editor-review.js';
import { colorModeExtension, editorColorMode, editorTheme } from './editor-theme.js';
import { createExtensionContributions } from './extension-contributions.js';
import { createExtensionManager } from './extension-manager.js';
import { createChangeLensPanel } from './change-lens-panel.js';
import { createFailureLens, refreshDebugGutter } from './failure-lens.js';
import { createFileIcon } from './file-icons.js';
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
import { createCommandCenter, createCommandRegistry } from './workbench-commands.js';
import { sourceLanguage } from './source-language.cjs';
import { runtimeKind } from './runtime-kind.cjs';
import { normalizeSource } from './source-text.cjs';
import { changeLineEnding, formatLineEndings, lineEndings, lineEndingHistory,
  parseLineEndings, sameLineEndings } from './line-endings.mjs';
import { intelligenceSuggestion, showIntelligenceSuggestion } from './intelligence/inline-suggestion.js';
import { createIntelligenceLayout } from './intelligence/workbench-layout.js';

const api = window.cevra;
const flightpathPanel = createFlightpathPanel({ api, errorText, checkInputs: () => testEvidence.recheck() });
const testEvidence = createTestEvidence(api, (evidence, checking) => {
  flightpathPanel.setEvidence(evidence, checking);
  renderTestPass(evidence, checking);
});
const byId = id => document.getElementById(id);
const terminalPanel = createTerminalPanel({ api, errorText, onActivity: renderTerminalActivity });
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
const explorerOpen = byId('explorer-open-next');
const runButton = byId('run-file');
const testButton = byId('run-tests');
const retryButton = byId('rerun-failures');
const stopButton = byId('stop-run');
const diagnosticButton = byId('jump-to-error');
const runDetails = byId('run-details');
const terminalActivity = byId('terminal-activity');
const lineEndingButton = byId('line-ending');
const lineEndingNames = { '\n': 'LF', '\r\n': 'CRLF', '\r': 'CR' };
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
let recentProjects = [];
let active;
let changingProject = true;
let openingFromExplorer = false;
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
let selectedTheme = defaultTheme;
let colorMode = 'dark';
let stagingEdits;
let intelligenceProposal;
let intelligenceTestActive = false;
let closingWorkbench = false;
let savingAll;
let editorSettings;
let draggedTab;

const view = new EditorView({ parent: editor });
const extensionContributions = createExtensionContributions({ api, editor, view, themeChoice,
  builtInTheme: () => selectedTheme, report });
for (const [name, button] of Object.entries(dockButtons)) button.dataset.view = name;
const layout = createWorkspaceLayout({ persist: api.setWorkbenchLayout, reveal: revealFolder, report });
const intelligenceLayout = createIntelligenceLayout({ api, report });
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

function applyAppearance({ theme, mode }) {
  const root = document.documentElement;
  const direction = theme === 'midnight' ? 'midnight' : 'ink';
  const modeChanged = mode !== colorMode;
  if (!modeChanged && root.dataset.direction === direction) return;
  colorMode = mode;
  root.dataset.colorMode = mode;
  root.dataset.direction = direction;
  terminalPanel.refreshTheme();
  if (!modeChanged) return;
  const effects = editorColorMode.reconfigure(colorModeExtension(mode === 'dark'));
  for (const tab of documents.values()) {
    if (tab === active) view.dispatch({ effects });
    else tab.state = tab.state.update({ effects }).state;
  }
}

api.onAppearance(applyAppearance);

async function changeTheme(choice) {
  try {
    if (choice.includes(':')) {
      await api.setExtensionPalette(choice);
    } else {
      const appearance = await api.setTheme(choice);
      selectedTheme = appearance.theme;
      applyAppearance(appearance);
    }
    notify('Theme saved.');
    await extensionContributions.refresh();
  } catch (error) {
    report(error);
    throw error;
  } finally {
    extensionContributions.syncThemeChoice();
  }
}

function syncCommands() {
  const open = [...documents.values()];
  const saving = savingAll || open.some(tab => tab.saving);
  const discarding = open.some(tab => tab.discarding);
  const runtime = runtimeKind(active?.path);
  byId('extension-manager-open').disabled = changingProject;
  byId('intelligence-mock-open').disabled = changingProject;
  intelligenceLayout.setBusy(changingProject || closingWorkbench);
  byId('intelligence-attach-selection').disabled = changingProject || !active || active.state.selection.main.empty;
  byId('intelligence-review-proposal').disabled = Boolean(changingProject || saving || discarding || run || stagingEdits);
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
  explorerOpen.disabled = openButton.disabled || openingFromExplorer || closingWorkbench;
  byId('open-commands').disabled = changingProject || closingWorkbench;
  for (const button of byId('recent-project-list').querySelectorAll('button')) button.disabled = openButton.disabled;
  saveButton.disabled = !active?.dirty || Boolean(active.saving || active.discarding || changingProject || changingGit);
  saveButton.hidden = Boolean(active?.recoveryConflict);
  recoveryButton.hidden = !active?.recoveryConflict;
  recoveryButton.disabled = !active?.dirty || Boolean(active.saving || changingProject);
  formatButton.disabled = !active?.language || Boolean(changingProject || active.formatting || active.discarding);
  inspectButton.disabled = definitionButton.disabled = findReferencesButton.disabled = !active?.language || changingProject;
  renameButton.disabled = !active?.language || changingProject || Boolean(run || saving || discarding);
  settingsButton.disabled = Boolean(changingProject || run || saving || discarding);
  byId('appearance-settings').disabled = settingsButton.disabled;
  lineEndingButton.disabled = !active || Boolean(changingProject || active.saving || active.discarding || active.formatting);
  byId('workspace-trust-state').disabled = settingsButton.disabled;
  byId('reveal-file').disabled = !active || changingProject;
  symbolButton.disabled = !project || changingProject;
  runButton.disabled = !runtime || Boolean(changingProject || changingGit || run || discarding || savingAll || intelligenceTestActive);
  runButton.hidden = Boolean(run);
  testButton.disabled = !project || Boolean(changingProject || changingGit || run || discarding || savingAll || intelligenceTestActive);
  retryButton.hidden = !retryAvailable || byId('run-panel').dataset.mode !== 'tests';
  retryButton.disabled = testButton.disabled;
  stopButton.hidden = !run;
  stopButton.disabled = run?.stage === 'stopping';
  searchToggle.disabled = !project || changingProject;
  backButton.disabled = changingProject || navigating || !navigation.peek('back');
  forwardButton.disabled = changingProject || navigating || !navigation.peek('forward');
}

function syncCursor() {
  byId('intelligence-attach-selection').disabled = changingProject || !active || active.state.selection.main.empty;
  if (!active) {
    byId('language').textContent = '';
    lineEndingButton.hidden = true;
    byId('cursor').textContent = '';
    return;
  }
  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  byId('language').textContent = active.language?.name ?? (runtimeKind(active.path) === 'python' ? 'Python' : 'Plain text');
  const { preferred, exceptions } = view.state.field(lineEndings);
  const ending = lineEndingNames[preferred];
  lineEndingButton.hidden = false;
  lineEndingButton.textContent = exceptions.size ? 'Mixed EOL' : ending;
  lineEndingButton.title = exceptions.size ? 'Mixed line endings. New lines use ' + ending + '. Change line endings.' :
    'Change line endings. Current format ' + ending + '.';
  lineEndingButton.setAttribute('aria-label', lineEndingButton.title);
  byId('cursor').textContent = `Ln ${line.number}, Col ${position - line.from + 1}`;
}

function syncDirty() {
  syncCommands();
  renderTabs();
  selectTreeFile();
  syncWorkspaceContext();
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
  return tab.bom + formatLineEndings(state.doc, state.field(lineEndings));
}

function isDirty(tab, state) {
  return !tab.savedDoc || tab.bom !== tab.savedBom || !state.doc.eq(tab.savedDoc) ||
    !sameLineEndings(state.doc, state.field(lineEndings), tab.savedEndings);
}

function queueDraft(tab, coalesce = false) {
  tab.draftPending = true;
  if (!tab.draftTask) {
    tab.draftTask = (async () => {
      while (tab.draftPending) {
        if (coalesce) await new Promise(resolve => setTimeout(resolve, 100));
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
  const endingChanged = before.field(lineEndings) !== state.field(lineEndings);
  if (docChanged) {
    navigation.map(tab.id, changes, state.doc);
    failureLens.mapBreakpoints(tab.path, before.doc, state.doc, changes);
  }
  if (docChanged || endingChanged) {
    tab.syntaxIssues = tab.typeIssues = tab.extensionIssues = undefined;
    tab.version++;
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
    queueDraft(tab, true);
    searchPanel.changed();
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
      lineEndings.init(() => ending),
      lineEndingHistory,
      intelligenceSuggestion,
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
    button.dataset.dirty = String(Boolean(project && findDocument(button.dataset.file)?.dirty));
  }
}

function syncWorkspaceContext() {
  const trust = byId('workspace-trust-state');
  trust.hidden = !project;
  trust.dataset.trusted = String(project?.trusted === true);
  trust.querySelector('span').textContent = project?.trusted ? 'Trusted' : 'Restricted';
  trust.setAttribute('aria-label', project?.trusted ? 'Trusted workspace settings' : 'Restricted workspace settings');
  byId('inspector-project').textContent = project?.name ?? 'No project open';
  byId('inspector-root').textContent = project?.root ?? '';
  byId('inspector-root').title = project?.root ?? '';
  byId('inspector-trust').textContent = !project ? 'Open a folder to view its details.' :
    project.trusted ? 'Execution trusted' : 'Execution requires permission';
  byId('inspector-file').hidden = !active;
  byId('inspector-file-name').textContent = active?.path ?? '';
  byId('inspector-file-state').textContent = active?.recoveryConflict ? 'Original changed · Recovery copy available' :
    active?.dirty ? 'Unsaved changes' : 'Saved';
}

api.onWorkspaceTrust(({ id, trusted }) => {
  if (project?.id !== id) return;
  project.trusted = trusted;
  syncWorkspaceContext();
  terminalPanel.trustChanged(trusted);
});

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
      button.onclick = () => openFromNavigation(entry.path).catch(report);
    }
    button.append(entry.directory ? icon('folder') : createFileIcon(entry.name), label(entry.name));
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

async function revealFolder(path, focus = true) {
  if (!project || changingProject) return;
  const current = project;
  const delimiter = current.caseInsensitivePaths ? '\\' : '/';
  const parts = path ? path.split(current.caseInsensitivePaths ? /[\\/]/ : '/') : [];
  const opened = [];
  let listing = current.files;
  for (const [index] of parts.entries()) {
    const segment = parts.slice(0, index + 1).join(delimiter);
    const entry = listing.find(item => item.directory && documentKey(item.path) === documentKey(segment));
    if (!entry) throw new Error('This folder is no longer in the Explorer. Reopen the project to refresh it.');
    const children = expanded.get(entry.path) ?? await api.list(current.id, entry.path);
    if (project !== current || changingProject) return;
    opened.push([entry.path, children]);
    listing = children;
  }
  for (const [folder, children] of opened) expanded.set(folder, children);
  layout.showSidebar();
  searchPanel.close();
  renderTree();
  if (focus) {
    const button = opened.length ? [...tree.querySelectorAll('button[data-folder]')].find(row => row.dataset.folder === opened.at(-1)[0]) :
      tree.querySelector('button');
    (button ?? searchToggle).focus();
  }
}

async function revealActiveFile() {
  const tab = active;
  if (!tab || changingProject) return;
  const separator = project.caseInsensitivePaths ? /[\\/]/ : /\//;
  const folder = tab.path.split(separator).slice(0, -1).join(project.caseInsensitivePaths ? '\\' : '/');
  await revealFolder(folder, false);
  if (active !== tab || changingProject) return;
  const row = [...tree.querySelectorAll('button[data-file]')].find(button => documentKey(button.dataset.file) === documentKey(tab.path));
  (row ?? searchToggle).focus();
}

tree.addEventListener('keydown', event => {
  const button = event.target.closest('button.file-item');
  if (!button || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
  const rows = [...tree.querySelectorAll('button.file-item:not(:disabled)')];
  const index = rows.indexOf(button);
  const row = button.parentElement;
  let target;
  switch (event.key) {
    case 'ArrowUp': target = rows[index - 1]; break;
    case 'ArrowDown': target = rows[index + 1]; break;
    case 'Home': target = rows[0]; break;
    case 'End': target = rows.at(-1); break;
    case 'ArrowRight':
      if (button.getAttribute('aria-expanded') === 'false') button.click();
      else target = row.querySelector(':scope > ul button');
      break;
    case 'ArrowLeft':
      if (button.getAttribute('aria-expanded') === 'true') button.click();
      else target = row.parentElement.parentElement.closest('li')?.querySelector('button');
      break;
    default: return;
  }
  event.preventDefault();
  target?.focus();
});

function orderedTabs() {
  return [...documents.values()].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || a.stripOrder - b.stripOrder);
}

function switchTab(step) {
  const open = orderedTabs();
  const index = open.indexOf(active);
  if (index === -1) return;
  ++fileRequest;
  showFile(open[(index + step + open.length) % open.length]);
}

function adjacentTab(step) {
  if (!active || changingProject) return null;
  const open = orderedTabs();
  const target = open[open.indexOf(active) + step];
  return target?.pinned === active.pinned ? target : null;
}

function moveTab(tab, target, after) {
  if (!tab || !target || tab === target || tab.pinned !== target.pinned || documents.get(tab.path) !== tab) return;
  const reordered = orderedTabs().filter(item => item !== tab);
  reordered.splice(reordered.indexOf(target) + Number(after), 0, tab);
  reordered.forEach((item, index) => { item.stripOrder = index; });
  renderTabs();
}

function renderTabs() {
  const focused = tabs.contains(document.activeElement) ? document.activeElement : null;
  const previous = focused?.closest('.tab')?.dataset.tabId;
  const focusClass = focused?.classList.contains('tab-close') ? '.tab-close' : '.tab-open';
  const oldScroll = tabs.scrollLeft;
  tabs.replaceChildren();
  tabs.hidden = !documents.size;
  for (const tab of orderedTabs()) {
    const item = document.createElement('div');
    item.className = tab === active ? 'tab active' : 'tab';
    item.dataset.tabId = String(tab.id);
    item.dataset.pinned = String(tab.pinned);
    item.draggable = true;
    item.ondragstart = event => {
      draggedTab = tab;
      event.dataTransfer.setData('application/x-vokri-tab', String(tab.id));
      event.dataTransfer.effectAllowed = 'move';
    };
    item.ondragover = event => {
      if (!event.dataTransfer.types.includes('application/x-vokri-tab') ||
          !draggedTab || draggedTab === tab || draggedTab.pinned !== tab.pinned) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      item.dataset.drop = 'true';
    };
    item.ondragleave = () => delete item.dataset.drop;
    item.ondragend = () => { draggedTab = undefined; };
    item.ondrop = event => {
      event.preventDefault();
      delete item.dataset.drop;
      if (event.dataTransfer.getData('application/x-vokri-tab') === String(draggedTab?.id)) {
        const bounds = item.getBoundingClientRect();
        moveTab(draggedTab, tab, event.clientX > bounds.x + bounds.width / 2);
      }
      draggedTab = undefined;
    };
    const show = document.createElement('button');
    show.className = 'tab-open';
    show.title = tab.path;
    if (tab === active) show.setAttribute('aria-current', 'true');
    show.append(createFileIcon(tab.name), label(tab.name));
    if (tab.pinned) show.append(icon('pin-view'));
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
  tabs.scrollLeft = oldScroll;
  if (previous) (tabs.querySelector(`[data-tab-id="${previous}"] ${focusClass}`) ??
    tabs.querySelector('.tab.active .tab-open'))?.focus({ preventScroll: true });
}

tabs.addEventListener('keydown', event => {
  const target = event.target.closest('.tab-open');
  if (!target || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const options = [...tabs.querySelectorAll('.tab-open')];
  const index = options.indexOf(target);
  const step = event.key === 'ArrowRight' ? 1 : -1;
  const next = event.key === 'Home' ? options[0] : event.key === 'End' ? options.at(-1) :
    options[(index + step + options.length) % options.length];
  next?.focus();
});

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
  layout.filePath(project, tab?.path);
  editor.hidden = !tab;
  byId('welcome').hidden = Boolean(tab);
  if (tab) {
    if (changed) {
      view.setState(tab.state);
      if (tab.scroll) view.dispatch({ effects: tab.scroll });
    }
    view.focus();
    if (changed) notify(tab.recoveryConflict ? 'The original changed or is unavailable. Save a recovery copy.' : tab.path,
      tab.recoveryConflict);
  }
  renderTabs();
  if (tab) tabs.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  selectTreeFile();
  syncWorkspaceContext();
  syncCommands();
  syncCursor();
  refreshIntelligenceSuggestion();
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
    stripOrder: documentSequence,
    pinned: false,
    version: 0,
    path,
    projectId: project.id,
    name: path.split(/[\\/]/).at(-1),
    language: sourceLanguage(path),
    revision,
    bom: text.startsWith('\uFEFF') ? '\uFEFF' : '',
    savedEndings: parseLineEndings(text),
    dirty: false,
  };
  tab.savedBom = tab.bom;
  tab.state = editorState(tab, normalizeSource(text), tab.savedEndings);
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
  return tab;
}

async function openFromNavigation(path) {
  const origin = captureLocation();
  const tab = await openFile(path);
  if (origin && tab && origin.documentId !== tab.id) {
    navigation.record(origin);
    syncCommands();
  }
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
  api.intelligenceDocumentClosed(tab.projectId, tab.path);
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
  commandCenter.close();
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
  renderRecentProjects();
  byId('project-title').textContent = project.name;
  byId('project-title').title = project.root;
  byId('welcome').querySelector('h1').textContent = 'Choose a file to edit.';
  byId('welcome-copy').textContent = 'The Explorer shows the files in this project.';
  retryAvailable = false;
  resetOutput();
  restoreDock();
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
  for (const file of next.explorerEntries ?? []) await openFromNavigation(file);
  if (next.unreadable) notify('Some draft backups could not be read. The backups are still on disk.', true);
  syncDirty();
}

async function openProject(picker) {
  if (openButton.disabled) return;
  changingProject = true;
  ++fileRequest;
  syncCommands();
  editor.inert = tree.inert = tabs.inert = true;
  byId('workbench').setAttribute('aria-busy', 'true');
  try {
    const open = [...documents.values()];
    const choice = open.some(tab => tab.dirty) ? await api.workspaceSwitchChoice(project.id) : 'keep';
    if (choice === 'cancel') return;
    await Promise.all(open.map(tab => choice === 'keep' && tab.draftError ? queueDraft(tab) : tab.draftTask));
    if (choice === 'keep' && open.some(tab => tab.dirty && tab.draftError)) throw new Error('A draft backup failed. Save the file or retry before switching.');
    const next = await picker(choice === 'discard');
    if (next) {
      await adoptProject(next);
      await refreshRecentProjects();
    }
  } finally {
    editor.inert = tree.inert = tabs.inert = false;
    byId('workbench').removeAttribute('aria-busy');
    if (active) view.focus();
    changingProject = false;
    syncCommands();
  }
}

const openRecent = id => openProject(discard => api.openRecent(id, discard)).catch(report);

async function openExplorerSelection() {
  if (explorerOpen.disabled || explorerOpen.hidden || document.querySelector('dialog[open]')) return;
  openingFromExplorer = true;
  syncCommands();
  let selection;
  let deferred = false;
  try {
    selection = await api.nextExplorerOpen();
    if (!selection) return;
    if (openButton.disabled || document.querySelector('dialog[open]')) {
      deferred = true;
      return;
    }
    if (selection.unavailable) throw new Error('An Explorer item changed or is unavailable. Select it again in Explorer.');
    if (selection.switch) await openProject(discard => api.openExplorerWorkspace(selection.id, discard));
    else if (selection.workspaceId === project?.id) {
      for (const file of selection.entries) await openFromNavigation(file);
    } else deferred = true;
  } catch (error) { report(error); }
  finally {
    if (selection && !deferred) await api.finishExplorerOpen(selection.id).catch(report);
    openingFromExplorer = false;
    syncCommands();
  }
}

explorerOpen.onclick = () => void openExplorerSelection();
api.onExplorerOpenChanged(({ pending, rejected, automatic }) => {
  explorerOpen.hidden = !pending;
  explorerOpen.textContent = `Open next Explorer selection (${pending})`;
  const reportRejected = () => {
    if (rejected) notify('Some Explorer items are unavailable or unsupported.', true);
  };
  if (automatic) void openExplorerSelection().then(reportRejected);
  else reportRejected();
});

function renderRecentProjects() {
  const list = byId('recent-project-list');
  const entries = recentProjects.filter(entry => entry.root !== project?.root).slice(0, 4);
  byId('recent-projects').hidden = entries.length === 0;
  list.replaceChildren(...entries.map(entry => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'recent-project';
    button.title = entry.root;
    button.disabled = openButton.disabled;
    button.append(icon('folder'), label(entry.name), label(entry.root));
    button.onclick = () => openRecent(entry.id);
    item.append(button);
    return item;
  }));
}

async function refreshRecentProjects() {
  recentProjects = await api.recentWorkspaces();
  renderRecentProjects();
}

function setDiskBaseline(tab, disk) {
  tab.savedDoc = disk ? Text.of(normalizeSource(disk.text).split('\n')) : null;
  tab.savedEndings = disk ? parseLineEndings(disk.text) : undefined;
  tab.savedBom = disk?.text.startsWith('\uFEFF') ? '\uFEFF' : '';
  tab.diskRevision = disk?.revision;
}

async function saveFile(tab) {
  if (!tab?.dirty || tab.discarding) return;
  if (tab.recoveryConflict) throw new Error('The original changed or is unavailable. Save a recovery copy.');
  if (tab.saving) return tab.saving;
  const task = async () => {
    if (tab.language && editorSettings?.formatOnSave) {
      const { doc } = tab.state;
      const ending = tab.state.field(lineEndings);
      const result = await api.format(tab.projectId, tab.path, doc.toString(), ending.preferred, Boolean(tab.bom));
      if (tab.state.doc !== doc || tab.state.field(lineEndings) !== ending) {
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
    api.extensionDocumentChanged(tab.projectId, tab.path);
    tab.savedDoc = before.doc;
    tab.savedEndings = before.field(lineEndings);
    tab.savedBom = tab.bom;
    tab.dirty = isDirty(tab, tab.state);
    await queueDraft(tab);
    searchPanel.changed();
    semantic.changed();
    if (/\.json$/i.test(tab.path)) referencesPanel.changed();
    const saved = 'Saved ' + tab.path;
    if (tab.draftError) notify(saved + '. The draft backup could not be updated.', true);
    else notify(saved);
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
    if (before.doc.eq(tab.state.doc) && sameLineEndings(before.doc, before.field(lineEndings), tab.state.field(lineEndings))) {
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
  const ending = tab.state.field(lineEndings);
  const stillEditing = () => active === tab && !changingProject && !tab.discarding &&
    !document.body.inert && !editor.inert && documents.get(tab.path) === tab;
  const stillCurrent = () => stillEditing() && tab.version === version;
  if (document.activeElement === formatButton) view.focus();
  tab.formatting = true;
  syncCommands();
  notify('Formatting ' + tab.path + '…');
  try {
    const result = await api.format(tab.projectId, tab.path, tab.state.doc.toString(), ending.preferred, Boolean(tab.bom));
    if (!stillCurrent()) {
      if (stillEditing()) notify('Formatting skipped because the document changed.');
      return;
    }
    if (!applyFormatResult(tab, ending, result)) {
      notify('No formatting changes for ' + tab.path);
      return;
    }
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
  const convert = result.eol !== ending.preferred || (result.normalizeEndings && ending.exceptions.size > 0);
  if (!result.changes.length && !convert) return false;
  const changes = tab.state.changes(result.changes);
  const transaction = tab.state.update({
    changes,
    selection: tab.state.selection.map(changes, 1),
    effects: convert ? [changeLineEnding.of(result.eol)] : [],
    annotations: isolateHistory.of('full'),
    scrollIntoView: tab === active && view.hasFocus,
    userEvent: 'input.format',
  });
  if (tab === active) view.dispatch(transaction);
  else updateDocument(tab, transaction.startState, transaction.state, transaction.changes, transaction.docChanged);
  return true;
}

function convertLineEndings(ending) {
  const { preferred, exceptions } = view.state.field(lineEndings);
  if (preferred === ending && !exceptions.size) return;
  view.dispatch({ effects: changeLineEnding.of(ending), annotations: isolateHistory.of('full') });
  view.focus();
  notify('Using ' + lineEndingNames[ending] + ' line endings.');
}

function renderTerminalActivity(count, busy) {
  const text = count === 1 ? '1 shell' : count + ' shells';
  const label = byId('terminal-count');
  if (count && label.textContent !== text) label.textContent = text;
  terminalActivity.hidden = count === 0;
  terminalActivity.disabled = busy;
  terminalActivity.title = count ? 'Show Terminal · ' + text + ' open' : '';
  terminalActivity.setAttribute('aria-label', terminalActivity.title || 'Open active terminals');
}

function setRunState(text, state = 'ready') {
  const badge = byId('run-state');
  badge.textContent = text;
  badge.dataset.state = state;
  runDetails.dataset.state = state;
  badge.classList.toggle('feedback-busy', state === 'running');
  const kind = byId('run-kind').textContent;
  runDetails.title = kind ? kind + ' · ' + text + ' · Open details' : text;
  runDetails.setAttribute('aria-label', kind ? kind + ' · ' + text + ' · Open details' : 'Open execution details');
}

function renderTestPass(evidence, checking) {
  if (!evidence || !testPass || evidence.id !== testPass.id) return;
  if (checking) setRunState('Pass · checking inputs', 'unverified');
  else if (evidence.freshness === 'historical') setRunState('Historical pass · ' + testPass.elapsed, 'unverified');
  else if (evidence.freshness === 'unavailable') setRunState('Pass · revision unavailable', 'unverified');
  else setRunState((evidence.retry ? 'Passed · retry only · ' : 'Passed · ') + testPass.elapsed, 'ok');
}

function showDock(name, focus = false, { expand = true, remember = true } = {}) {
  layout.view(name, { open: expand, remember });
  for (const [pane, button] of Object.entries(dockButtons)) button.setAttribute('aria-pressed', String(pane === name));
  byId('problems-panel').hidden = byId('problems-status').hidden = name !== 'problems';
  byId('references-panel').hidden = name !== 'references';
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

function restoreDock() {
  const pane = layout.pane;
  const available = project && (pane !== 'terminal' || project.terminalLimit);
  showDock(available ? pane : 'output', false, { expand: false, remember: false });
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
  renderRunLocation();
  byId('run-target').textContent = target;
  const kind = byId('run-kind');
  kind.textContent = target ? { file: 'Run', tests: 'Tests', tasks: 'Task', recipe: 'Recipe', debug: 'Debug' }[mode] : '';
  kind.hidden = !target;
  runDetails.disabled = !target;
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
  setRunState('Canceled', 'interrupted');
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
      if (mode !== 'debug' || failureLens.phase !== 'paused') setRunState('Running', 'running');
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
  setRunState('Stopping', 'running');
  syncCommands();
  if (attempt.sessionId) await api.stop(attempt.workspaceId, attempt.id, attempt.sessionId);
}

function locationLabel({ path, line, column }) {
  return `${path}:${line}:${column}`;
}

function jumpToTaskSource(anchor, isCurrent) {
  jumpToRecordedSource(anchor, isCurrent, 'The recorded task source changed or is unavailable. Run the task again to refresh this location.');
}

function jumpToRecordedSource(anchor, isCurrent, staleMessage, onStale) {
  return jumpToLocation(anchor, {
    revision: anchor.revision, isCurrent, staleMessage, changedMessage: staleMessage,
    validate: doc => anchor.line <= doc.lines && anchor.column <= doc.line(anchor.line).length + 1,
  }).catch(error => {
    if (!isCurrent()) return;
    report(error);
    onStale?.();
  });
}

function runSourceNote(text) {
  const note = byId('run-source-note');
  note.textContent = note.title = text;
  note.hidden = !text;
}

function renderRunLocation({ location, unverifiedLocation, summary } = {}) {
  diagnostic = location?.revision ? location : undefined;
  diagnosticButton.hidden = !diagnostic;
  diagnosticButton.querySelector('span').textContent = diagnostic ? locationLabel(diagnostic) : '';
  const reported = unverifiedLocation ?? (!diagnostic && location);
  runSourceNote(reported ? 'Source revision unavailable · ' + locationLabel(reported) : '');
  byId('run-source-label').hidden = !diagnostic;
  const detail = byId('run-error-summary');
  detail.textContent = detail.title = summary ?? '';
  byId('run-diagnostic').hidden = !diagnostic && !reported && !summary;
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
    row.onclick = () => jumpToRecordedSource(anchor, isCurrent, staleMessage, () => void testEvidence.recheck());
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
    setRunState('Canceled', 'interrupted');
    empty.textContent = 'The test run was canceled.';
  } else if (event.code === 0 && counts?.tests === 0) {
    setRunState('No tests', 'unverified');
    empty.textContent = 'No JavaScript tests were discovered in this project.';
  } else if (event.code === 0 && counts && counts.passed === counts.cached) {
    setRunState('No tests passed', 'unverified');
    empty.textContent = 'This run produced no new passing tests.';
  } else if (event.code === 0 && counts) {
    const evidence = testEvidence.latest;
    if (evidence) {
      testPass = { id: evidence.id, elapsed };
      renderTestPass(evidence);
    } else setRunState('Pass · revision unavailable', 'unverified');
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
  if (event.type === 'debug-state' && run.mode === 'debug' && run.stage !== 'stopping') {
    failureLens.state(event);
    if (event.state === 'paused') setRunState('Paused · ' + event.reason, 'paused');
    else setRunState('Running', 'running');
  }
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
  if (!event.stopped) renderRunLocation(event);
  if (mode === 'tasks' || mode === 'recipe') {
    testEvidence.finish(event.evidence, sourceVersion);
    if (event.stopped) setRunState('Canceled', 'interrupted');
    else if (event.code === 0) setRunState('Completed · ' + elapsed, 'ok');
    else setRunState(event.completedWithFailures && mode === 'tasks' ? 'Completed with failures' :
      mode === 'recipe' ? 'Recipe failed' : 'Task failed', 'error');
    if (event.error) appendOutput(event.error);
    if (!outputText) output.textContent = mode === 'recipe' ? 'The recipe produced no output.' : 'The tasks produced no output.';
    taskPanel.blockWaiting(event.stopped ? 'Run canceled' : 'Execution could not continue');
    flightpathPanel.refresh();
    syncCommands();
    return;
  }
  if (event.stopped) setRunState('Canceled', 'interrupted');
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
  return true;
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

const settingsDialog = createSettingsCenter({
  api, getProject: () => project, apply: applyEditorSettings, changeTheme, resetLayout: resetWorkspaceLayout,
  manageExtensions: () => byId('extension-manager-open').click(), openStore: () => extensionManager.openStore(),
  openIntelligence: api.openIntelligenceSettings, intelligenceAvailable: intelligenceLayout.settingsAvailable, errorText, report,
});

function openSettings(category) {
  if (!settingsButton.disabled) void settingsDialog.show(category);
}

async function resetWorkspaceLayout() {
  layout.reset();
  restoreDock();
  if (!await layout.flush()) throw new Error('The default layout could not be saved.');
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
      const path = tab?.path ?? file.path;
      const disk = await api.read(workspace.id, path);
      bytes += encoder.encode(disk.text).byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('Narrow the preview to at most 16 MiB of source.');
      if (project !== workspace || findDocument(path) !== tab || tab?.version !== version ||
          tab?.recoveryConflict || tab?.saving || tab?.discarding ||
          (tab && tab.revision !== disk.revision) ||
          (file.documentId === undefined ? file.revision !== disk.revision || tab?.dirty :
            tab?.id !== file.documentId || version !== file.version)) throw staleEdits(path);
      const original = doc ?? Text.of(normalizeSource(disk.text).split('\n'));
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
      if (changed.length) changes.push({ path, tab, version, disk, doc: original, edits: changed });
    }
    return { workspace, changes, skipped, authority };
  },
  stage(prepared, verify) {
    const body = document.body;
    const lock = Boolean(prepared.authority?.intelligenceProposalId);
    if (lock) body.inert = true;
    stagingEdits = stageEdits(prepared, verify).finally(() => {
      stagingEdits = undefined;
      if (lock && !closingWorkbench) body.inert = false;
      syncCommands();
    });
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
    const { path, tab, disk, doc, version, edits } = file;
    if (findDocument(path) !== tab || tab?.version !== version ||
        (tab && (tab.state.doc !== doc || tab.revision !== disk.revision ||
          tab.recoveryConflict || tab.saving || tab.discarding || tab.formatting))) throw staleEdits(path);
    const state = tab?.state ?? EditorState.create({ doc, extensions: lineEndings.init(() => parseLineEndings(disk.text)) });
    const modified = state.update({ changes: edits }).state;
    const bom = tab?.bom ?? (disk.text.startsWith('\uFEFF') ? '\uFEFF' : '');
    return { path, text: bom + formatLineEndings(modified.doc, modified.field(lineEndings)), revision: disk.revision };
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

function editorSnapshot({ workspaceId, path, allowedFiles }, normalized = false) {
  if (project?.id !== workspaceId || changingProject) return null;
  const tab = path ? findDocument(path) : active;
  if (!tab || tab.recoveryConflict || tab.saving || tab.discarding || tab.formatting) return null;
  if (allowedFiles && !allowedFiles.some(file => documentKey(file) === documentKey(tab.path))) return null;
  const selection = tab.state.selection.main;
  return { path: tab.path.replaceAll('\\', '/'), text: normalized ? tab.state.doc.toString() : serialize(tab), baseRevision: tab.revision,
    documentId: tab.id, version: tab.version, selection: { from: selection.from, to: selection.to } };
}
api.onExtensionEditorSnapshot(editorSnapshot);
api.onIntelligenceEditorSnapshot(request => editorSnapshot(request, true));
api.onIntelligencePatchSnapshot(request => {
  const snapshot = editorSnapshot(request);
  const tab = project?.id === request.workspaceId ? findDocument(request.path) : undefined;
  return snapshot ? { ...snapshot, lineEnding: tab.state.field(lineEndings).preferred } :
    tab ? { blocked: true } : null;
});

function refreshIntelligenceSuggestion() {
  if (!active) return;
  const inline = intelligenceProposal?.inline;
  showIntelligenceSuggestion(view, inline && active.id === inline.documentId && active.version === inline.version &&
    inline.at <= active.state.doc.length ? inline : null);
}

api.onIntelligenceProposalChanged(proposal => {
  intelligenceProposal = proposal?.workspaceId === project?.id ? proposal : null;
  byId('intelligence-review-proposal').hidden = byId('intelligence-dismiss-proposal').hidden = !intelligenceProposal;
  refreshIntelligenceSuggestion();
  if (intelligenceProposal) notify('Intelligence proposed edits in ' + proposal.fileCount + (proposal.fileCount === 1 ? ' file.' : ' files.'));
});
api.onIntelligenceTestActive(active => {
  intelligenceTestActive = active === true;
  syncCommands();
});
byId('intelligence-review-proposal').onclick = () => {
  const proposal = intelligenceProposal;
  if (proposal) editPreview.intelligence(() => api.intelligenceProposal(proposal.workspaceId, proposal.id));
};
api.onIntelligenceReviewRequested(() => {
  const button = byId('intelligence-review-proposal');
  if (!button.disabled && !button.hidden) button.click();
});
byId('intelligence-dismiss-proposal').onclick = () => {
  const proposal = intelligenceProposal;
  if (proposal) void api.dismissIntelligenceProposal(proposal.workspaceId, proposal.id).catch(report);
};
api.onIntelligenceSourceLocation(async ({ workspaceId, source }) => {
  const opened = project;
  const isCurrent = () => !changingProject && project === opened && project?.id === workspaceId;
  if (!isCurrent()) return false;
  const selected = source.kind === 'selection' ? findDocument(source.path) : undefined;
  if (source.kind === 'selection' && !selected) return false;
  return jumpToLocation({ path: source.path, line: source.line, column: 1,
    offset: source.from, length: source.to === undefined ? 0 : source.to - source.from }, {
    isCurrent, revision: source.revision, documentId: source.documentId, version: source.version,
    allowDraft: source.kind === 'selection',
    validate: () => !selected || (findDocument(source.path) === selected && selected.id === source.documentId &&
      selected.version === source.version && selected.revision === source.revision && !selected.saving && !selected.discarding),
    staleMessage: 'This Intelligence source has changed.',
  });
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

async function jumpToRunError() {
  const target = diagnostic;
  if (!target) return;
  const jumped = await jumpToRecordedSource(target, () => diagnostic === target,
    'The recorded runtime source changed or is unavailable. Run the file again to refresh this location.',
    () => runSourceNote('Source changed or is unavailable. Rerun to refresh the recorded location.'));
  if (jumped && diagnostic === target) runSourceNote('');
}

runDetails.onclick = () => showDock(dock.dataset.mode === 'debug' ? 'failure' : 'output', true);
terminalActivity.onclick = () => showDock('terminal', true);

const dockNames = { output: 'Run output', problems: 'Problems', references: 'References', terminal: 'Terminal',
  flightpath: 'Flightpath', tasks: 'Tasks', recipes: 'Recipes', failure: 'Failure Lens', changes: 'Change Lens' };
const canUse = button => () => !button.disabled && !button.hidden;
const editorFocused = () => view.hasFocus;
const canDebugFile = () => Boolean(active && runtimeKind(active.path) === 'javascript');
const canEditDocument = () => Boolean(active && !changingProject && !active.discarding);
const editorReview = createEditorReview();
const editorActions = [
  ['undo', 'Undo edit', undo, () => canEditDocument() && undoDepth(view.state) > 0],
  ['redo', 'Redo edit', redo, () => canEditDocument() && redoDepth(view.state) > 0],
  ['find-in-file', 'Find or replace in file', openSearchPanel],
  ['go-line', 'Go to Line', gotoLine],
  ['fold', 'Fold at cursor', foldCode],
  ['unfold', 'Unfold at cursor', unfoldCode],
  ['comment', 'Toggle Line Comment', toggleLineComment, () => canEditDocument() && Boolean(active.language)],
  ['cursor-above', 'Add Cursor Above', addCursorAbove],
  ['cursor-below', 'Add Cursor Below', addCursorBelow],
  ['select-next', 'Select Next Occurrence', selectNextOccurrence],
];
const commands = createCommandRegistry([
  { id: 'find', title: 'Find files', detail: 'Search by file name or path', icon: 'search', key: 'Ctrl+P',
    enabled: canUse(byId('open-commands')), run: () => commandCenter.open() },
  { id: 'commands', title: 'Show commands', icon: 'search', key: 'Ctrl+Shift+P', alternate: 'F1', hidden: true,
    enabled: canUse(byId('open-commands')), run: () => commandCenter.open('commands') },
  { id: 'open', title: 'Open folder', detail: 'Choose a project on this device', icon: 'folder', key: 'Ctrl+O',
    enabled: canUse(openButton), run: () => openProject(api.chooseFolder) },
  { id: 'recent', title: 'Open recent project', icon: 'folder', enabled: canUse(openButton), run: () => commandCenter.open('projects') },
  { id: 'example', title: 'Open example', detail: 'Try editing and running a JavaScript project', icon: 'play',
    enabled: canUse(exampleButton), run: () => openProject(api.openExample) },
  { id: 'save', title: 'Save file', icon: 'save', key: 'Ctrl+S', enabled: canUse(saveButton), run: () => saveFile(active) },
  { id: 'save-all', title: 'Save all files', icon: 'save', key: 'Ctrl+Shift+S',
    enabled: () => !changingProject && !changingGit && [...documents.values()].some(tab => tab.dirty), run: saveAll },
  { id: 'recover', title: 'Save recovery copy', icon: 'save', enabled: canUse(recoveryButton), run: () => saveRecoveredCopy(active) },
  ...editorActions.map(([id, title, action, enabled = canEditDocument]) => ({ id, title, enabled, run: () => {
    view.focus();
    action(view);
  } })),
  { id: 'review-unsaved', title: 'Review Unsaved Changes', icon: 'file',
    enabled: () => Boolean(canEditDocument() && active.dirty && active.savedDoc),
    run: () => editorReview.open(active, { dark: colorMode === 'dark', options: editorSettings }) },
  { id: 'resume', title: 'Continue debugging', icon: 'play', key: 'F5',
    context: () => run?.mode === 'debug' && failureLens.phase === 'paused',
    enabled: () => run?.mode === 'debug' && failureLens.phase === 'paused', run: () => failureLens.action('resume') },
  { id: 'run', title: 'Run file', icon: 'play', key: 'F5', enabled: canUse(runButton), run: runFile },
  { id: 'run-tests', title: 'Run tests', icon: 'flask', key: 'Ctrl+Alt+T', enabled: canUse(testButton), run: () => runTests() },
  { id: 'retry', title: 'Rerun failures', icon: 'flask', enabled: canUse(retryButton), run: () => runTests(true) },
  { id: 'stop', title: 'Stop run', icon: 'stop', enabled: canUse(stopButton), run: stopRun },
  { id: 'error', title: 'Go to run error', words: 'fix diagnostic', enabled: () => Boolean(diagnostic), run: jumpToRunError },
  { id: 'debug', title: 'Debug file', icon: 'play', key: 'F6', context: editorFocused,
    enabled: canDebugFile, run: runDebug },
  { id: 'breakpoint', title: 'Toggle breakpoint', key: 'F9', context: editorFocused, enabled: canDebugFile,
    run: () => failureLens.toggle(active.path, view.state.doc.lineAt(view.state.selection.main.head).number) },
  { id: 'search', title: 'Search project', detail: 'Find text across files and drafts', icon: 'search', key: 'Ctrl+Shift+F',
    enabled: canUse(searchToggle), run: () => { layout.showSidebar(); searchPanel.show(); } },
  { id: 'format', title: 'Format document', icon: 'format', key: 'Alt+Shift+F', enabled: canUse(formatButton), run: formatDocument },
  { id: 'line-endings', title: 'Change line endings', hidden: true, enabled: canUse(lineEndingButton),
    run: () => commandCenter.open('commands', 'Convert line endings') },
  ...Object.entries(lineEndingNames).map(([ending, name]) => ({ id: 'line-ending-' + name, title: 'Convert line endings to ' + name,
    enabled: canUse(lineEndingButton), run: () => convertLineEndings(ending) })),
  { id: 'definition', title: 'Go to Definition', key: 'F12', context: editorFocused, enabled: canUse(definitionButton),
    run: () => { view.focus(); return definitionNavigation.go(view); } },
  { id: 'references', title: 'Find References', key: 'Shift+F12', context: editorFocused, enabled: canUse(findReferencesButton),
    run: () => { view.focus(); return referencesPanel.find(view); } },
  { id: 'inspect', title: 'Inspect symbol', key: 'Ctrl+Alt+I', enabled: canUse(inspectButton),
    run: () => { view.focus(); return symbolInfo.inspect(view); } },
  { id: 'symbol', title: 'Go to Symbol', detail: 'Find declarations in the current project', icon: 'find-symbol', key: 'Ctrl+T',
    enabled: canUse(symbolButton), run: symbolPicker.open },
  { id: 'rename', title: 'Rename Symbol', key: () => editorSettings?.renameShortcut === 'ctrl-alt-r' ? 'Ctrl+Alt+R' : 'F2',
    context: editorFocused, enabled: canUse(renameButton), run: renameSymbol },
  { id: 'back', title: 'Go back', icon: 'back', key: 'Alt+ArrowLeft', enabled: canUse(backButton), run: () => travel('back') },
  { id: 'forward', title: 'Go forward', icon: 'forward', key: 'Alt+ArrowRight', enabled: canUse(forwardButton), run: () => travel('forward') },
  { id: 'next-tab', title: 'Next file tab', key: 'Ctrl+Tab', enabled: () => documents.size > 1 && !changingProject, run: () => switchTab(1) },
  { id: 'previous-tab', title: 'Previous file tab', key: 'Ctrl+Shift+Tab', enabled: () => documents.size > 1 && !changingProject, run: () => switchTab(-1) },
  { id: 'close-tab', title: 'Close file tab', icon: 'close', key: 'Ctrl+W', enabled: () => Boolean(active && !changingProject), run: () => closeFile(active) },
  { id: 'pin-tab', title: 'Pin or unpin active file tab', icon: 'pin-view', enabled: () => Boolean(active && !changingProject),
    run: () => { active.pinned = !active.pinned; renderTabs(); } },
  { id: 'move-tab-left', title: 'Move active file tab left', icon: 'back', enabled: () => Boolean(adjacentTab(-1)),
    run: () => moveTab(active, adjacentTab(-1), false) },
  { id: 'move-tab-right', title: 'Move active file tab right', icon: 'forward', enabled: () => Boolean(adjacentTab(1)),
    run: () => moveTab(active, adjacentTab(1), true) },
  { id: 'reveal', title: 'Reveal active file in Explorer', icon: 'folder', enabled: canUse(byId('reveal-file')), run: revealActiveFile },
  { id: 'explorer', title: 'Toggle Explorer', icon: 'sidebar-layout', key: 'Ctrl+B', run: layout.toggleSidebar },
  { id: 'focus-explorer', title: 'Focus Explorer', icon: 'sidebar-layout', enabled: () => Boolean(project && !changingProject), run: () => revealFolder('') },
  { id: 'panel', title: 'Toggle bottom panel', icon: 'panel-layout', key: 'Ctrl+J', run: layout.toggleDock },
  { id: 'details', title: 'Toggle workspace details', icon: 'inspector-layout', run: layout.toggleInspector },
  { id: 'float', title: 'Float or dock bottom panel', icon: 'float-panel', run: layout.toggleFloating },
  { id: 'pin-view', title: 'Pin or unpin current panel view', icon: 'pin-view', enabled: canUse(byId('pin-panel')), run: layout.pinView },
  { id: 'reset-layout', title: 'Reset workspace layout', icon: 'panel-layout', run: resetWorkspaceLayout },
  ...Object.entries(dockButtons).map(([pane, button]) => ({ id: 'view-' + pane, title: 'Show ' + dockNames[pane],
    icon: 'panel-layout', key: pane === 'problems' ? 'Ctrl+Shift+M' : pane === 'terminal' ? 'Ctrl+`' : undefined,
    enabled: canUse(button), run: () => showDock(pane, true) })),
  { id: 'settings', title: 'Settings', icon: 'settings-icon', key: 'Ctrl+,', enabled: canUse(settingsButton), run: () => openSettings() },
  { id: 'appearance-settings', title: 'Appearance settings', detail: 'Change theme and editor palettes',
    enabled: canUse(settingsButton), run: () => openSettings('appearance') },
  { id: 'workspace-settings', title: 'Workspace settings', detail: 'Review execution trust and layout',
    enabled: canUse(settingsButton), run: () => openSettings('workspace') },
  { id: 'extensions', title: 'Extensions', enabled: canUse(byId('extension-manager-open')), run: () => byId('extension-manager-open').click() },
  { id: 'extension-store', title: 'Extension Store', detail: 'Browse online and bundled packages',
    enabled: canUse(byId('extension-manager-open')), run: extensionManager.openStore },
  { id: 'intelligence', title: 'VOKRI Intelligence', enabled: canUse(byId('intelligence-mock-open')), run: () => api.openIntelligenceMock() },
  { id: 'intelligence-workspace', title: 'Open Intelligence workspace', enabled: canUse(byId('intelligence-dock-open')),
    run: intelligenceLayout.openDock },
], report);

const commandCenter = createCommandCenter({ api, registry: commands, workspace: () => project, recent: () => recentProjects,
  openFiles: () => [active, ...orderedTabs().filter(tab => tab !== active)].filter(Boolean),
  openFile: file => openFromNavigation(file).catch(report), openRecent, icon, fileIcon: createFileIcon, errorText });

for (const [pane, button] of Object.entries(dockButtons)) commands.bind(button, 'view-' + pane);
for (const [button, command] of [
  [byId('open-commands'), 'find'], [backButton, 'back'], [forwardButton, 'forward'],
  [openButton, 'open'], [welcomeOpen, 'open'], [exampleButton, 'example'], [saveButton, 'save'],
  [recoveryButton, 'recover'], [formatButton, 'format'], [lineEndingButton, 'line-endings'], [inspectButton, 'inspect'], [definitionButton, 'definition'],
  [symbolButton, 'symbol'], [findReferencesButton, 'references'], [renameButton, 'rename'], [settingsButton, 'settings'],
  [byId('appearance-settings'), 'appearance-settings'], [byId('workspace-trust-state'), 'workspace-settings'],
  [byId('reveal-file'), 'reveal'], [runButton, 'run'], [testButton, 'run-tests'],
  [retryButton, 'retry'], [stopButton, 'stop'], [diagnosticButton, 'error'], [byId('intelligence-mock-open'), 'intelligence'],
  [byId('toggle-sidebar'), 'explorer'], [byId('toggle-inspector'), 'details'], [byId('toggle-dock'), 'panel'],
  [byId('rail-dock'), 'panel'], [byId('float-dock'), 'float'], [byId('pin-panel'), 'pin-view'],
]) commands.bind(button, command);
byId('intelligence-attach-selection').onclick = () => {
  if (!active || changingProject) return;
  const { from, to } = active.state.selection.main;
  if (to > from) void api.openIntelligenceMock({ path: active.path.replaceAll('\\', '/'),
    documentId: active.id, version: active.version, from, to }).catch(report);
};

api.beforeClose(async () => {
  closingWorkbench = true;
  document.body.inert = true;
  try {
    await layout.flush();
    await stagingEdits?.catch(() => {});
    await savingAll;
    const open = [...documents.values()];
    await Promise.allSettled(open.map(tab => tab.saving));
    await Promise.all(open.map(tab => tab.draftError ? queueDraft(tab) : tab.draftTask));
    await api.closeReady(open.some(tab => tab.dirty), open.some(tab => tab.draftError));
  } catch (error) {
    closingWorkbench = false;
    document.body.inert = false;
    report(error);
  }
});

api.onCloseCanceled(() => {
  closingWorkbench = false;
  document.body.inert = false;
  if (active) view.focus();
});

async function initialize() {
  syncCommands();
  try {
    const appearance = await api.appearance();
    themeChoice.value = selectedTheme = appearance.theme;
    applyAppearance(appearance);
    const [preferences] = await Promise.all([api.workbenchLayout(), refreshRecentProjects()]);
    layout.restore(preferences);
    syncWorkspaceContext();
    await extensionContributions.refresh();
    const initial = await api.initial();
    intelligenceLayout.setFeatures(initial);
    if (initial.project) await adoptProject(initial.project);
    else {
      applyEditorSettings((await api.editorSettings()).effective);
      restoreDock();
    }
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
  if (event.isComposing || (view.hasFocus && view.compositionStarted) || document.querySelector('dialog[open]') || closingWorkbench) return;
  if (terminalPanel.handles(event) && event.key !== 'F1' && event.code !== 'Backquote') return;
  if (event.key === 'Escape' && view.hasFocus && symbolInfo.dismiss(view)) event.preventDefault();
  commands.keydown(event);
}, { capture: true });

void initialize();
