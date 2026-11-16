import { indentUnit } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export const editorOptions = new Compartment();

export function optionExtensions(settings) {
  const width = settings?.indentWidth ?? 2;
  return [
    indentUnit.of(settings?.indentStyle === 'tabs' ? '\t' : ' '.repeat(width)),
    EditorState.tabSize.of(width),
    settings?.wrap ? EditorView.lineWrapping : [],
  ];
}
