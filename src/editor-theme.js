import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

export const editorColorMode = new Compartment();
const darkMode = EditorView.darkTheme.of(true);

export function colorModeExtension(dark) {
  return dark ? darkMode : [];
}

const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--extension-editor-syntax-accent, var(--syntax-keyword))' },
  { tag: [tags.string, tags.regexp, tags.escape], color: 'var(--extension-editor-foreground, var(--syntax-string))' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--extension-editor-syntax-accent, var(--syntax-number))' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: 'var(--extension-editor-syntax-accent, var(--syntax-type))' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--extension-editor-foreground, var(--syntax-property))' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--extension-editor-syntax-accent, var(--syntax-function))' },
  { tag: [tags.comment, tags.meta], color: 'var(--extension-editor-foreground, var(--muted))' },
  { tag: tags.invalid, color: 'var(--danger)' },
]);

export const editorTheme = [EditorView.theme({
  '&': {
    backgroundColor: 'var(--extension-editor-background, var(--base))',
    color: 'var(--extension-editor-foreground, var(--text))',
    fontSize: 'var(--editor-font-size, 14px)',
  },
  '.cm-scroller': { fontFamily: 'var(--editor-font, var(--mono))', lineHeight: '1.6' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--extension-editor-accent, var(--mint))' },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--extension-editor-accent, var(--mint))', borderLeftWidth: 'var(--editor-cursor-width, 1px)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--extension-editor-background, var(--base))',
    color: 'var(--extension-editor-foreground, var(--muted))', borderRight: '1px solid var(--line)',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--extension-editor-active-line, var(--active-line))' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--extension-editor-selection, var(--editor-selection))',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--selected)' },
  '.cm-searchMatch': { backgroundColor: 'var(--search-match)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--search-current)', outline: '1px solid var(--warning)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--selected)', color: 'var(--mint)' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--error-surface)', color: 'var(--danger)' },
  '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--line)' },
  '.cm-panel input:not([type=checkbox]), .cm-panel button:not([name=close])': {
    backgroundColor: 'var(--raised)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: '3px',
  },
  '.cm-panel input[type=checkbox]': { accentColor: 'var(--mint)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--selected)', color: 'var(--text)' },
  '.cm-tooltip.cm-tooltip-above .cm-tooltip-arrow:before': { borderTopColor: 'var(--line)' },
  '.cm-tooltip.cm-tooltip-above .cm-tooltip-arrow:after': { borderTopColor: 'var(--panel)' },
  '.cm-tooltip.cm-tooltip-below .cm-tooltip-arrow:before': { borderBottomColor: 'var(--line)' },
  '.cm-tooltip.cm-tooltip-below .cm-tooltip-arrow:after': { borderBottomColor: 'var(--panel)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--raised)', color: 'var(--muted)', borderColor: 'var(--line)' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
}), syntaxHighlighting(highlighting)];
