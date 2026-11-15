import { invertedEffects } from '@codemirror/commands';
import { MapMode, RangeSet, RangeValue, StateEffect, StateField } from '@codemirror/state';

export const changeLineEnding = StateEffect.define();

class LineBreak extends RangeValue {
  // The marker belongs to the newline character after its position.
  startSide = 1;
  endSide = 1;
  mapMode = MapMode.TrackAfter;
  point = true;

  constructor(ending) {
    super();
    this.ending = ending;
  }
}

const markers = Object.fromEntries(['\n', '\r\n', '\r'].map(ending => [ending, new LineBreak(ending)]));
const uniform = preferred => ({ preferred, exceptions: RangeSet.empty });
const restoreBreaks = StateEffect.define({ map: (ranges, changes) => ranges.map(changes) });
const restoreLayout = StateEffect.define({
  map: (layout, changes) => ({ ...layout, exceptions: layout.exceptions.map(changes) }),
});

export const lineEndings = StateField.define({
  create: () => uniform('\n'),
  update(layout, transaction) {
    let { preferred, exceptions } = layout;
    exceptions = exceptions.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(changeLineEnding)) ({ preferred, exceptions } = uniform(effect.value));
      else if (effect.is(restoreLayout)) ({ preferred, exceptions } = effect.value);
      else if (effect.is(restoreBreaks)) {
        const add = [];
        effect.value.between(0, transaction.newDoc.length, (from, _to, value) => add.push(value.range(from)));
        exceptions = exceptions.update({ add });
      }
    }
    return preferred === layout.preferred && exceptions === layout.exceptions ? layout : { preferred, exceptions };
  },
});

export const lineEndingHistory = invertedEffects.of(transaction => {
  const before = transaction.startState.field(lineEndings);
  if (transaction.effects.some(effect => effect.is(changeLineEnding) || effect.is(restoreLayout))) {
    return [restoreLayout.of(before)];
  }
  if (!before.exceptions.size || !transaction.docChanged) return [];
  const deleted = [];
  transaction.changes.iterChangedRanges((start, end) => {
    if (start === end) return;
    before.exceptions.between(start, end, (from, _to, value) => {
      if (from >= start && from < end) deleted.push(value.range(from));
    });
  });
  return deleted.length ? [restoreBreaks.of(RangeSet.of(deleted))] : [];
});

export function detectLineEnding(text) {
  if (text.includes('\r\n')) return '\r\n';
  if (text.includes('\n')) return '\n';
  if (text.includes('\r')) return '\r';
  return '\n';
}

export function parseLineEndings(text) {
  const preferred = detectLineEnding(text);
  const exceptions = [];
  let shift = text.startsWith('\uFEFF') ? 1 : 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    const ending = match[0];
    if (ending !== preferred) exceptions.push(markers[ending].range(match.index - shift));
    shift += ending.length - 1;
  }
  return { preferred, exceptions: RangeSet.of(exceptions) };
}

export function formatLineEndings(doc, { preferred, exceptions }) {
  const text = doc.toString();
  if (!exceptions.size) return preferred === '\n' ? text : text.replaceAll('\n', preferred);
  const cursor = exceptions.iter();
  let previousOffset = -2;
  let previousEnding;
  return text.replace(/\n/g, (_newline, offset) => {
    let ending = preferred;
    if (cursor.value && cursor.from === offset) {
      ending = cursor.value.ending;
      cursor.next();
    }
    // Consecutive CR and LF would reopen as one line break. Keep both lines.
    if (previousOffset === offset - 1 && previousEnding === '\r' && ending === '\n') ending = '\r\n';
    previousOffset = offset;
    previousEnding = ending;
    return ending;
  });
}

export function sameLineEndings(doc, first, second) {
  if (first === second || doc.lines === 1) return true;
  if (!first.exceptions.size && !second.exceptions.size) return first.preferred === second.preferred;
  return (first.preferred === second.preferred && RangeSet.eq([first.exceptions], [second.exceptions])) ||
    formatLineEndings(doc, first) === formatLineEndings(doc, second);
}
