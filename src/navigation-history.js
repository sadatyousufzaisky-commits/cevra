export function createNavigationHistory() {
  const back = [];
  const forward = [];
  const stack = direction => direction === 'back' ? back : forward;

  function push(entries, location) {
    if (!location) return;
    entries.push(location);
    if (entries.length > 100) entries.shift();
  }

  return {
    peek(direction) {
      return stack(direction).at(-1);
    },
    record(origin) {
      push(back, origin);
      forward.length = 0;
    },
    complete(direction, origin) {
      stack(direction).pop();
      push(direction === 'back' ? forward : back, origin);
    },
    discard(direction, location) {
      if (stack(direction).at(-1) === location) stack(direction).pop();
    },
    map(documentId, changes, doc) {
      for (const entries of [back, forward]) {
        for (const location of entries) {
          if (location.documentId !== documentId) continue;
          location.selection = location.selection.map(changes);
          const head = location.selection.main.head;
          const line = doc.lineAt(head);
          location.line = line.number;
          location.column = head - line.from + 1;
          location.scroll = undefined;
        }
      }
    },
    clear() {
      back.length = forward.length = 0;
    },
  };
}
