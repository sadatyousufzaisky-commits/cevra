import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

const showSuggestion = StateEffect.define();

class SuggestionWidget extends WidgetType {
  constructor(suggestion) { super(); this.suggestion = suggestion; }
  eq(other) { return other.suggestion === this.suggestion; }
  toDOM() {
    const hint = document.createElement('span');
    hint.className = 'intelligence-inline-suggestion';
    hint.setAttribute('aria-hidden', 'true');
    hint.textContent = '  Suggestion ' + (this.suggestion.text || (this.suggestion.removal ? 'Remove selection' : 'Review replacement'));
    return hint;
  }
}

export const intelligenceSuggestion = StateField.define({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged) value = null;
    for (const effect of transaction.effects) {
      if (effect.is(showSuggestion)) value = effect.value;
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => value ?
    Decoration.set([Decoration.widget({ widget: new SuggestionWidget(value), side: 1 }).range(value.at)]) : Decoration.none),
});

export function showIntelligenceSuggestion(view, value) {
  if (view.state.field(intelligenceSuggestion, false) !== value) view.dispatch({ effects: showSuggestion.of(value) });
}
