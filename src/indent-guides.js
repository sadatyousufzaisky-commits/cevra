import { getIndentUnit } from '@codemirror/language';
import { countColumn, EditorState } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';

function guides(view) {
  const { state } = view;
  const tabSize = state.facet(EditorState.tabSize);
  const unit = getIndentUnit(state);
  const decorations = [];
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    for (let line = state.doc.lineAt(from); line.from <= to; line = state.doc.line(line.number + 1)) {
      if (line.from > last) {
        last = line.from;
        const indent = /^[\t ]*/.exec(line.text.slice(0, 160))[0];
        const columns = Math.min(160, Math.floor(countColumn(indent, tabSize) / unit) * unit);
        if (columns) {
          decorations.push(Decoration.line({ attributes: {
            class: 'cm-indent-guides', style: `--guide-width:${columns}ch;--guide-step:${unit}ch`,
          } }).range(line.from));
        }
      }
      if (line.number === state.doc.lines) break;
    }
  }
  return Decoration.set(decorations);
}

export const indentGuides = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = guides(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged) this.decorations = guides(update.view);
  }
}, { decorations: plugin => plugin.decorations });
