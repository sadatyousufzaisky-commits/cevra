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

export function createEditorSettings({ api, getProject, apply, errorText }) {
  const byId = id => document.getElementById(id);
  const dialog = byId('settings-dialog');
  const form = byId('settings-form');
  const scope = byId('settings-scope');
  const status = byId('settings-status');
  const reset = byId('settings-reset');
  const save = byId('settings-save');
  const close = byId('settings-close');
  const revoke = byId('trust-revoke');
  const trust = byId('settings-trust');
  const trustStatus = byId('trust-status');
  let data;
  let busy = false;

  function render() {
    const workspace = scope.value === 'workspace';
    const values = workspace ? data.effective : data.global;
    for (const [name, value] of Object.entries(values)) {
      const field = form.elements.namedItem(name);
      if (typeof value === 'boolean') field.checked = value;
      else field.value = value;
    }
    reset.hidden = !workspace || !Object.keys(data.overrides).length;
    status.textContent = workspace ? 'Changes here override global settings for this workspace.' : '';
  }

  async function operation(action) {
    if (busy) return;
    busy = true;
    save.disabled = reset.disabled = close.disabled = revoke.disabled = scope.disabled = true;
    try {
      await action();
    } catch (error) {
      status.textContent = errorText(error);
    } finally {
      busy = false;
      reset.disabled = close.disabled = revoke.disabled = false;
      save.disabled = scope.disabled = !data;
    }
  }

  async function showTrust(id) {
    trust.hidden = !id;
    if (!id) return;
    const trusted = await api.workspaceTrust(id);
    trustStatus.textContent = trusted ? 'Workspace execution is trusted.' : 'CEVRA will ask before running workspace code.';
    revoke.hidden = !trusted;
  }

  async function saveSettings(values) {
    const id = getProject()?.id;
    data = await api.setEditorSettings(id, scope.value, values);
    apply(data.effective);
    render();
    status.textContent = 'Settings saved.';
  }

  scope.onchange = () => render();
  close.onclick = () => dialog.close();
  dialog.oncancel = event => { if (busy) event.preventDefault(); };
  reset.onclick = () => void operation(() => saveSettings(null));
  revoke.onclick = () => void operation(async () => {
    const { id } = getProject();
    await api.revokeTrust(id);
    await showTrust(id);
  });
  form.onsubmit = event => {
    event.preventDefault();
    void operation(async () => {
      const original = scope.value === 'workspace' ? data.effective : data.global;
      const values = {};
      for (const [name, value] of Object.entries(original)) {
        const field = form.elements.namedItem(name);
        const next = typeof value === 'boolean' ? field.checked :
          typeof value === 'number' ? field.valueAsNumber : field.value;
        if (next !== value) values[name] = next;
      }
      await saveSettings(values);
    });
  };

  return {
    async show() {
      if (dialog.open || busy) return;
      data = undefined;
      const id = getProject()?.id;
      scope.options[1].disabled = !id;
      scope.value = id ? 'workspace' : 'global';
      status.textContent = 'Loading settings…';
      trust.hidden = true;
      reset.hidden = true;
      dialog.showModal();
      await operation(async () => {
        data = await api.editorSettings(id);
        render();
        await showTrust(id);
      });
    },
  };
}
