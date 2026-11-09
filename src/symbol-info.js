import { StateEffect, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { closeHoverTooltips, hoverTooltip, showTooltip } from '@codemirror/view';

const setManual = StateEffect.define();
const manualTooltip = StateField.define({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged || transaction.selection) value = null;
    for (const effect of transaction.effects) {
      if (effect.is(setManual)) value = effect.value;
    }
    return value;
  },
  provide: field => showTooltip.from(field),
});

function tooltip(info) {
  return {
    pos: info.from,
    end: info.to,
    above: true,
    arrow: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'symbol-info';
      dom.setAttribute('role', 'tooltip');
      const signature = document.createElement('pre');
      signature.className = 'symbol-signature';
      signature.textContent = info.signature;
      dom.append(signature);
      if (info.documentation) {
        const details = document.createElement('p');
        details.className = 'symbol-documentation';
        details.textContent = info.documentation;
        dom.append(details);
      }
      return { dom };
    },
  };
}

export function createSymbolInfo({ api, getActive, getDocuments, available, notify, report }) {
  const snapshots = new WeakMap();
  const requests = { hover: 0, inspect: 0 };
  let generation = 0;

  function snapshot(tab) {
    const doc = tab.state.doc;
    let cached = snapshots.get(tab);
    if (cached?.doc !== doc) {
      cached = { doc, text: doc.toString() };
      snapshots.set(tab, cached);
    }
    return { path: tab.path, documentId: tab.id, version: tab.version, text: cached.text };
  }

  function query(tab, position, kind) {
    const id = ++requests[kind];
    const epoch = generation;
    const version = tab.version;
    const buffers = [snapshot(tab)];
    for (const other of getDocuments()) {
      if (other !== tab && other.language && other.dirty) buffers.push(snapshot(other));
    }
    return {
      result: api.quickInfo(tab.projectId, tab.path, position, buffers),
      current: () => id === requests[kind] && epoch === generation && tab.version === version &&
        available() && getActive() === tab,
    };
  }

  const hover = hoverTooltip(async (view, position, side) => {
    const tab = getActive();
    if (!tab?.language || !available() || view.state.field(manualTooltip, false)) return null;
    const node = syntaxTree(view.state).resolveInner(position, side);
    if (!/(?:Name|Definition|Identifier)$/.test(node.name) || node.to <= node.from) return null;
    const offset = Math.max(node.from, Math.min(position, node.to - 1));
    const request = query(tab, offset, 'hover');
    try {
      const info = await request.result;
      return request.current() && info?.signature ? tooltip(info) : null;
    } catch {
      return null;
    }
  }, { hideOnChange: true });

  return {
    extension: [manualTooltip, hover],
    changed() { generation++; },
    leave(tab) {
      generation++;
      if (!tab.language) return;
      tab.state = tab.state.update({ effects: [setManual.of(null), closeHoverTooltips] }).state;
    },
    dismiss(view) {
      requests.inspect++;
      const manual = view.state.field(manualTooltip, false);
      if (!manual) return false;
      view.dispatch({ effects: setManual.of(null) });
      return true;
    },
    async inspect(view) {
      const tab = getActive();
      if (!tab?.language || !available()) return;
      const selection = view.state.selection;
      const request = query(tab, selection.main.head, 'inspect');
      const current = () => request.current() && view.state.selection.eq(selection);
      try {
        const info = await request.result;
        if (!current()) return;
        view.dispatch({ effects: [
          closeHoverTooltips,
          setManual.of(info?.signature ? tooltip(info) : null),
        ] });
        notify(info?.signature || 'No symbol information at the cursor.');
      } catch (error) {
        if (current()) report(error);
      }
    },
  };
}
