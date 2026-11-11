import { closeCompletion, completionStatus, insertCompletionText, pickedCompletion } from '@codemirror/autocomplete';
import { isolateHistory } from '@codemirror/commands';
import { snippets, typescriptSnippets } from '@codemirror/lang-javascript';

const trigger = /[\p{ID_Continue}$\u200c\u200d.('"{,]$/u;
const icons = new Map([
  ['const', 'variable'], ['let', 'variable'], ['var', 'variable'], ['local var', 'variable'],
  ['parameter', 'variable'], ['local function', 'function'], ['local class', 'class'],
  ['getter', 'property'], ['setter', 'property'], ['accessor', 'property'], ['JSX attribute', 'property'],
  ['enum member', 'enum'], ['type parameter', 'type'], ['primitive type', 'type'],
  ['alias', 'variable'], ['module', 'namespace'], ['string', 'text'],
]);

export function createSemanticCompletion({ semantic, getActive, report }) {
  async function complete(context) {
    const tab = getActive();
    const view = context.view;
    const { pos, state } = context;
    const { doc, selection } = state;
    if (!tab?.language || !semantic.available() || !view?.hasFocus ||
        selection.ranges.length !== 1 || !selection.main.empty) return null;
    if (!context.explicit && !trigger.test(doc.sliceString(Math.max(0, pos - 2), pos))) return null;

    context.addEventListener('abort', () => {}, { onDocChange: true });
    const request = semantic.query('complete', tab, pos);
    const current = () => request.current() && view.hasFocus && view.state.doc === doc &&
      view.state.selection.eq(selection) && completionStatus(view.state) !== null;
    try {
      const result = await request.result;
      if (context.aborted || !current() || !result?.options.length) return null;

      const options = result.options.map(item => ({
        label: item.label,
        type: icons.get(item.kind) ?? (item.kind || 'text'),
        detail: item.kind || 'symbol',
        apply(view, completion) {
          if (!current()) return void closeCompletion(view);
          view.dispatch({
            ...insertCompletionText(view.state, item.insert, item.from, item.to),
            annotations: [pickedCompletion.of(completion), isolateHistory.of('full')],
          });
        },
      }));
      if (result.global) {
        const keywords = new Set(result.options.filter(item => item.kind === 'keyword').map(item => item.label));
        for (const snippet of tab.language.typescript ? typescriptSnippets : snippets) {
          if (!keywords.has(snippet.label)) continue;
          options.push({
            ...snippet,
            type: 'text',
            detail: 'snippet · ' + snippet.detail,
            apply(view, completion, from, to) {
              if (!current()) return void closeCompletion(view);
              snippet.apply(view, completion, from, to);
            },
          });
        }
      }
      return { from: result.from, to: result.to, options, filter: false, map: () => null };
    } catch (error) {
      if (context.explicit && !context.aborted && current()) report(error);
      return null;
    }
  }

  return complete;
}
