import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { StateEffect, StateField } from '@codemirror/state';
import { EditorView, keymap, showTooltip, ViewPlugin } from '@codemirror/view';

const tooltipId = 'cevra-signature-help';
const setSignature = StateEffect.define();
const signatureField = StateField.define({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged || transaction.selection) value = null;
    for (const effect of transaction.effects) {
      if (effect.is(setSignature)) value = effect.value;
    }
    return value;
  },
  provide: field => showTooltip.from(field),
});

function insideCall(state, position) {
  for (let node = syntaxTree(state).resolveInner(position, -1); node; node = node.parent) {
    if (node.name === 'ArgList' && node.firstChild?.name === '(' && node.firstChild.to <= position &&
        (node.lastChild?.name !== ')' || position < node.to)) return true;
  }
  return false;
}

function signatureTooltip(position, result) {
  return {
    pos: position,
    above: true,
    arrow: true,
    create() {
      const dom = document.createElement('div');
      dom.id = tooltipId;
      dom.className = 'signature-help';
      dom.setAttribute('role', 'tooltip');
      const label = document.createElement('pre');
      label.className = 'signature-label';
      label.append(result.before);
      if (result.parameter) {
        const active = document.createElement('strong');
        active.className = 'signature-parameter';
        active.setAttribute('aria-current', 'true');
        active.textContent = result.parameter;
        label.append(active, result.after);
      }
      dom.append(label);
      if (result.overloadCount > 1) {
        const overload = document.createElement('div');
        overload.className = 'signature-overload';
        overload.textContent = `Overload ${result.overload} of ${result.overloadCount}`;
        dom.append(overload);
      }
      if (result.documentation) {
        const details = document.createElement('p');
        details.className = 'signature-documentation';
        details.textContent = result.documentation;
        dom.append(details);
      }
      return { dom };
    },
  };
}

export function createSignatureHelp({ semantic, getActive, notify, report }) {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.sequence = 0;
      this.pending = false;
      this.schedule();
    }

    cancel() {
      const pending = this.pending || this.timer !== undefined;
      this.sequence++;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.pending = false;
      return pending;
    }

    update(update) {
      const position = update.state.selection.main.head;
      if (update.docChanged || update.selectionSet || update.focusChanged ||
          (!syntaxTreeAvailable(update.startState, position) && syntaxTreeAvailable(update.state, position))) {
        this.schedule();
      }
    }

    schedule() {
      this.cancel();
      const { state, hasFocus } = this.view;
      const { main, ranges } = state.selection;
      if (!hasFocus || !semantic.available() || ranges.length !== 1 || !main.empty || !insideCall(state, main.head)) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.query(false);
      }, 60);
    }

    async query(explicit) {
      const { view } = this;
      const { doc, selection } = view.state;
      const tab = getActive();
      if (!tab?.language || !view.hasFocus || !semantic.available() ||
          selection.ranges.length !== 1 || !selection.main.empty) return;
      const id = ++this.sequence;
      this.pending = true;
      const position = selection.main.head;
      let request;
      const current = () => id === this.sequence && view.hasFocus && view.state.doc === doc &&
        view.state.selection.eq(selection) && (!request || request.current());
      try {
        request = semantic.query('signatureHelp', tab, position);
        const result = await request.result;
        if (!current()) return;
        if (result || view.state.field(signatureField)) {
          view.dispatch({ effects: setSignature.of(result ? signatureTooltip(position, result) : null) });
        }
        if (explicit && !result) notify('No function signature at the cursor.');
      } catch (error) {
        if (explicit && current()) report(error);
      } finally {
        if (id === this.sequence) this.pending = false;
      }
    }

    destroy() { this.cancel(); }
  });

  function dismiss(view) {
    const pending = view.plugin(plugin)?.cancel();
    const visible = view.state.field(signatureField, false);
    if (visible) view.dispatch({ effects: setSignature.of(null) });
    return Boolean(visible || pending);
  }

  return {
    dismiss,
    extension: [
      signatureField,
      plugin,
      EditorView.focusChangeEffect.of((state, focusing) =>
        !focusing && state.field(signatureField) ? setSignature.of(null) : null),
      EditorView.contentAttributes.compute([signatureField], state =>
        state.field(signatureField) ? { 'aria-describedby': tooltipId } : {}),
      keymap.of([
        { key: 'Escape', run: dismiss },
        { key: 'Mod-Shift-Space', run(view) {
          const help = view.plugin(plugin);
          if (!help) return false;
          help.cancel();
          void help.query(true);
          return true;
        } },
      ]),
    ],
  };
}
