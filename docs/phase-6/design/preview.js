import { createFileIcon } from '../../../src/file-icons.js';

const root = document.documentElement;
const byId = id => document.getElementById(id);
const samples = new Map([
  ['main.ts', 'const site = "North ridge";\nconst observations = [12, 14, 15];\n\nfor (const count of observations) {\n  console.log(site, count);\n}\n'],
  ['survey.py', 'def describe(site, count):\n    return f"{site}: {count} observations"\n\nprint(describe("North ridge", 14))\n'],
  ['notes.md', '# Field notes\n\nCompare counts across the three visits.\n'],
  ['bad.js', 'const observations = undefined;\nconsole.log(observations.length);\n'],
]);
const icons = [
  'main.mjs', 'app.ts', 'types.d.mts', 'panel.jsx', 'panel.tsx', 'survey.py', 'index.html',
  'site.css', 'data.json', 'notes.md', 'build.ps1', '.editorconfig', 'package.json',
  'pipeline.yaml', 'query.sql', 'visits.csv', 'main.rs', 'main.go', 'math.c', 'vector.cpp',
  'Program.cs', 'App.java', 'logo.svg', 'assets.zip', 'LICENSE',
];

const source = byId('source');
const editorLabel = byId('editor-label');
const save = byId('save');
const run = byId('run');
const stop = byId('stop');
const outcome = byId('outcome');
const jump = byId('jump');
const preferences = byId('preferences');
const rows = new Map();
const drafts = new Map();
let active;
let timer;

byId('direction').addEventListener('change', event => { root.dataset.direction = event.target.value; });
byId('mode').addEventListener('change', event => { root.dataset.colorMode = event.target.value; });

function fileLabel(name, dirty = false) {
  const text = document.createElement('span');
  text.textContent = dirty ? name + ' · Draft' : name;
  return [createFileIcon(name), text];
}

function showFile(name) {
  rows.get(active)?.removeAttribute('aria-current');
  active = name;
  rows.get(name).setAttribute('aria-current', 'true');
  source.value = drafts.get(name) ?? samples.get(name);
  renderDraft();
}

function renderDraft() {
  save.disabled = !drafts.has(active);
  if (editorLabel.dataset.file !== active || editorLabel.dataset.dirty !== String(!save.disabled)) {
    editorLabel.dataset.file = active;
    editorLabel.dataset.dirty = String(!save.disabled);
    editorLabel.replaceChildren(...fileLabel(active, !save.disabled));
  }
}

function showOutcome(message, state = '') {
  outcome.textContent = message;
  outcome.className = { error: 'feedback-error', busy: 'feedback-busy' }[state] ?? '';
  jump.hidden = state !== 'error';
}

function finishRun() {
  timer = undefined;
  run.disabled = false;
  stop.hidden = true;
}

for (const name of samples.keys()) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-row';
  button.append(...fileLabel(name));
  button.addEventListener('click', () => showFile(name));
  rows.set(name, button);
  byId('files').append(button);
}
for (const name of icons) {
  const item = document.createElement('li');
  item.append(...fileLabel(name));
  byId('icons').append(item);
}

source.addEventListener('input', () => {
  if (source.value === samples.get(active)) drafts.delete(active);
  else drafts.set(active, source.value);
  renderDraft();
});
save.addEventListener('click', () => {
  samples.set(active, source.value);
  drafts.delete(active);
  if (document.activeElement === save) source.focus();
  renderDraft();
  showOutcome('Saved ' + active);
});
run.addEventListener('click', () => {
  const file = active;
  stop.hidden = false;
  stop.focus();
  run.disabled = true;
  showOutcome('Running ' + file, 'busy');
  timer = setTimeout(() => {
    const restoreFocus = document.activeElement === stop;
    finishRun();
    if (restoreFocus) run.focus();
    if (file === 'bad.js') showOutcome('TypeError in bad.js, line 2', 'error');
    else showOutcome('Completed ' + file);
  }, 900);
});
stop.addEventListener('click', () => {
  clearTimeout(timer);
  finishRun();
  run.focus();
  showOutcome('Stopped');
});
jump.addEventListener('click', () => {
  showFile('bad.js');
  const start = source.value.indexOf('\n') + 1;
  source.focus();
  source.setSelectionRange(start, source.value.length);
});
byId('settings').addEventListener('click', () => {
  preferences.returnValue = '';
  preferences.showModal();
});
preferences.addEventListener('close', () => {
  if (preferences.returnValue === 'apply') source.style.fontSize = byId('size').valueAsNumber + 'px';
  else byId('size').value = parseInt(getComputedStyle(source).fontSize, 10);
});
showFile('main.ts');
