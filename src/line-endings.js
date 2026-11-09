import { invertedEffects } from '@codemirror/commands';
import { StateEffect, StateField } from '@codemirror/state';

export const changeLineEnding = StateEffect.define();
export const lineEnding = StateField.define({
  create: () => '\n',
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(changeLineEnding)) value = effect.value;
    }
    return value;
  },
});

export const lineEndingHistory = invertedEffects.of(transaction =>
  transaction.effects.some(effect => effect.is(changeLineEnding)) ?
    [changeLineEnding.of(transaction.startState.field(lineEnding))] : []);

export function detectLineEnding(text) {
  if (text.includes('\r\n')) return '\r\n';
  if (text.includes('\n')) return '\n';
  if (text.includes('\r')) return '\r';
  return '\n';
}
