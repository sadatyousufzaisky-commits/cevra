const themes = Object.freeze({
  dark: 'Iris Ink Dark', light: 'Iris Ink Light', midnight: 'Midnight Atelier', system: 'System',
});
const defaultTheme = 'dark';

const editorFields = Object.freeze({
  fontSize: {
    label: 'Font size', detail: 'Sets the size of source text in the editor.',
    keywords: 'bigger smaller zoom text accessibility pixels', default: 14, min: 10, max: 32, unit: ' px',
  },
  fontFamily: {
    label: 'Font family', detail: 'Chooses the typeface used for source text.',
    keywords: 'typeface monospace', default: 'default', options: { default: 'Default', consolas: 'Consolas', courier: 'Courier New' },
  },
  indentWidth: {
    label: 'Indent width', detail: 'Sets how many columns a tab or indentation level occupies.',
    keywords: 'tab size spaces indentation tabSize', default: 2, min: 1, max: 8,
  },
  indentStyle: {
    label: 'Indentation', detail: 'Inserts spaces or tabs when you indent code.',
    keywords: 'tabs spaces insertSpaces indentStyle', default: 'spaces', options: { spaces: 'Spaces', tabs: 'Tabs' },
  },
  wrap: {
    label: 'Wrap lines', detail: 'Wraps long lines within the editor width without changing the file.',
    keywords: 'horizontal scroll word wrap wordWrap long lines', default: false,
  },
  lineNumbers: {
    label: 'Show line numbers', detail: 'Shows line numbers beside the source text.',
    keywords: 'gutter lineNumbers', default: true,
  },
  cursor: {
    label: 'Cursor width', detail: 'Sets the width of the caret in the source editor.',
    keywords: 'caret accessibility cursorWidth', default: 'thin', options: { thin: 'Thin', wide: 'Wide' },
  },
  formatOnSave: {
    label: 'Format JavaScript and TypeScript on save', detail: 'Formats JavaScript and TypeScript when you save a valid file.',
    keywords: 'autoformat formatter formatOnSave prettier tidy', default: false,
  },
  renameShortcut: {
    label: 'Rename shortcut', detail: 'Chooses the keyboard shortcut that opens Rename Symbol.',
    keywords: 'hotkey keybinding refactor renameShortcut', default: 'f2', options: { f2: 'F2', 'ctrl-alt-r': 'Ctrl+Alt+R' },
  },
});

const editorDefaults = Object.freeze(Object.fromEntries(
  Object.entries(editorFields).map(([key, field]) => [key, field.default])));

function validEditorValue(key, value) {
  if (!Object.hasOwn(editorFields, key)) return false;
  const field = editorFields[key];
  if (typeof value !== typeof field.default) return false;
  if (field.options) return Object.hasOwn(field.options, value);
  if (typeof value === 'number') return Number.isInteger(value) && value >= field.min && value <= field.max;
  return true;
}

module.exports = { defaultTheme, themes, editorFields, editorDefaults, validEditorValue };
