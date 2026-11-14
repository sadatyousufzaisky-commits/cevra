(() => {
  const api = window.intelligenceMock;
  const byId = id => document.getElementById(id);
  const attachments = byId('context-attachments');
  const sources = byId('context-sources');
  const context = byId('intelligence-context');
  const responseSources = byId('response-sources');
  const attachFile = byId('attach-file');
  const attachInstructions = byId('attach-instructions');
  const status = byId('context-status');
  const preferences = byId('response-preferences');
  const preferenceForm = byId('preference-form');
  const preferenceStatus = byId('preference-status');
  let state;
  let busy = false;

  function sourceLabel({ path, kind, line, endLine }) {
    if (kind !== 'selection') return path + (kind === 'instructions' ? ' · Project instructions' : ' · Saved file');
    return path + ':' + line + (endLine === line ? '' : '–' + endLine) + ' · Editor selection';
  }

  function render(next) {
    state = next;
    context.hidden = !next.enabled;
    preferences.hidden = !next.enabled;
    byId('context-help').textContent = next.workspace ?
      'Use Attach selection to Intelligence in the editor, or choose saved files here.' : 'Open a workspace to attach context.';
    attachFile.disabled = attachInstructions.disabled = busy || !next.workspace;
    const focusedId = document.activeElement?.dataset.contextId;
    const attachmentRows = next.entries.map(item => {
      const row = document.createElement('li');
      const remove = document.createElement('button');
      const label = sourceLabel(item);
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', 'Remove ' + label);
      remove.dataset.contextId = item.id;
      remove.disabled = busy;
      remove.onclick = () => void action(() => api.removeContext(item.id), 'Attachment removed.');
      row.append(label, remove);
      return row;
    });
    attachments.replaceChildren(...attachmentRows);
    responseSources.hidden = !next.sources.length;
    sources.replaceChildren(...next.sources.map(item => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Open ' + sourceLabel(item);
      button.dataset.contextId = item.id;
      button.disabled = item.historical || busy;
      button.onclick = () => void action(() => api.openSource(item.id), '');
      row.append(button);
      if (item.historical) row.append(' · Historical source');
      return row;
    }));
    if (focusedId) [...document.querySelectorAll('[data-context-id]')].find(element =>
      element.dataset.contextId === focusedId && !element.disabled)?.focus();
  }

  async function action(operation, message) {
    if (busy || !state) return;
    busy = true;
    const focusedId = document.activeElement?.dataset.contextId;
    render(state);
    status.textContent = '';
    try {
      const result = await operation();
      status.textContent = result.ok ? message : result.message;
      if (result.ok && result.value?.entries) render(result.value);
    } catch { status.textContent = 'The context operation could not finish.'; }
    finally {
      busy = false;
      render(state);
      if (focusedId && document.activeElement === document.body) {
        const next = [...document.querySelectorAll('[data-context-id]')].find(element =>
          element.dataset.contextId === focusedId && !element.disabled);
        if (next) next.focus();
        else if (!attachFile.disabled && !responseSources.hidden) byId('check-sources').focus();
        else if (!attachFile.disabled) attachFile.focus();
      }
    }
  }

  attachFile.onclick = () => void action(api.attachFile, '');
  attachInstructions.onclick = () => void action(api.attachInstructions, '');
  byId('check-sources').onclick = () => void action(api.checkSources, 'Source revisions checked.');
  preferences.addEventListener('toggle', async () => {
    if (!preferences.open) return;
    preferenceForm.inert = true;
    try {
      const result = await api.preferences();
      if (!result.ok) throw new Error();
      for (const [key, value] of Object.entries(result.value)) preferenceForm.elements[key].value = value;
      preferenceForm.inert = false;
    } catch { preferenceStatus.textContent = 'Response preferences are unavailable.'; }
  });
  preferenceForm.onsubmit = async event => {
    event.preventDefault();
    const save = byId('save-response-preferences');
    if (save.disabled) return;
    save.disabled = true;
    try {
      const result = await api.savePreferences(Object.fromEntries(new FormData(preferenceForm)));
      preferenceStatus.textContent = result.ok ? 'Response preferences saved.' : result.message;
    } catch { preferenceStatus.textContent = 'Response preferences could not be saved.'; }
    finally { save.disabled = false; }
  };
  api.onContextChanged(render);
  api.context().then(render).catch(() => {});
})();
