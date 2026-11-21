import { defaultTheme, themes, editorFields, validEditorValue } from './settings-schema.cjs';

const stopWords = new Set(['a', 'can', 'change', 'how', 'i', 'make', 'my', 'the', 'to']);

function searchable(value) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formatValue(field, value) {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  return field.options?.[value] ?? String(value) + (field.unit ?? '');
}

export function createSettingsCenter({ api, getProject, apply, changeTheme, resetLayout, manageExtensions,
  openStore, openIntelligence, intelligenceAvailable, errorText, report }) {
  const byId = id => document.getElementById(id);
  const dialog = byId('settings-dialog');
  const form = byId('settings-form');
  const scope = byId('settings-scope');
  const search = byId('settings-search');
  const content = dialog.querySelector('.settings-content');
  const results = byId('settings-results');
  const status = byId('settings-status');
  const pending = byId('settings-pending');
  const save = byId('settings-save');
  const reset = byId('settings-reset');
  const close = byId('settings-close');
  const theme = byId('theme-choice');
  const themeReset = byId('theme-reset');
  const revoke = byId('trust-revoke');
  const trustStatus = byId('trust-status');
  const exportButton = byId('settings-export');
  const resetLayoutButton = byId('settings-reset-layout');
  const extensionButton = byId('settings-extensions');
  const storeButton = byId('settings-store');
  const about = byId('about-product');
  const defaultApps = byId('windows-default-apps');
  const defaultAppsRow = byId('windows-default-apps-setting');
  const installUpdate = byId('windows-install-update');
  const installUpdateRow = byId('windows-install-update-setting');
  if (api.windowsInstaller === 'preview') byId('windows-install-update-note').textContent = 'Signed updates are unavailable in this preview.';
  const intelligenceButtons = [...dialog.querySelectorAll('[data-intelligence-settings]')];
  const categories = [...dialog.querySelectorAll('[data-settings-category]')];
  const drafts = { global: new Map(), workspace: new Map() };
  let data;
  let busy = false;
  let category = 'all';

  for (const [value, label] of Object.entries(themes)) theme.add(new Option(label, value));
  byId('theme-default').textContent = 'Default · ' + themes[defaultTheme] + ' · Global';

  const fields = Object.entries(editorFields).map(([key, field]) => {
    const row = element('div', '', 'settings-row');
    row.dataset.setting = key;
    row.dataset.keywords = field.keywords;
    const description = element('div');
    const label = element('label', field.label);
    const detail = element('p', field.detail);
    detail.id = 'setting-detail-' + key;
    const note = element('p', '', 'setting-default');
    note.id = 'setting-default-' + key;
    const controls = element('div', '', 'setting-controls');
    const input = element(field.options ? 'select' : 'input');
    input.id = label.htmlFor = 'setting-' + key;
    input.name = key;
    input.setAttribute('aria-describedby', detail.id + ' ' + note.id);
    if (field.options) {
      for (const [value, label] of Object.entries(field.options)) input.add(new Option(label, value));
    } else if (typeof field.default === 'boolean') input.type = 'checkbox';
    else {
      input.type = 'number';
      input.min = field.min;
      input.max = field.max;
      input.required = true;
    }
    const restore = element('button', 'Reset', 'button setting-reset');
    restore.type = 'button';
    restore.setAttribute('aria-label', 'Reset ' + field.label);
    description.append(label, detail, note);
    controls.append(input, restore);
    row.append(description, controls);
    byId('settings-fields').append(row);
    return { key, field, input, restore, row, note };
  });

  const sections = [...dialog.querySelectorAll('[data-settings-section]')].map(section => ({
    section,
    rows: [...section.querySelectorAll('[data-setting]')].filter(row =>
      (row !== defaultAppsRow || api.windowsIntegration) && (row !== installUpdateRow || api.windowsInstaller)).map(row => ({
      row, index: searchable([row.dataset.setting, row.dataset.keywords, section.querySelector('h3').textContent, row.textContent].join(' ')),
    })),
  }));

  const workspace = () => scope.value === 'workspace';
  const draft = () => drafts[scope.value];
  const dirty = () => drafts.workspace.size > 0 || drafts.global.size > 0;
  const currentValue = key => (workspace() ? data.effective : data.global)[key];
  const inherits = key => workspace() && !Object.hasOwn(data.overrides, key);

  function tell(message, error = false) {
    status.textContent = message;
    status.dataset.error = String(error);
  }

  function filter() {
    const words = searchable(search.value).split(' ').filter(word => word && !stopWords.has(word));
    let visible = 0;
    for (const { section, rows } of sections) {
      const selected = category === 'all' || section.dataset.settingsSection === category;
      let sectionCount = 0;
      for (const { row, index } of rows) {
        row.hidden = !selected || !words.every(word => index.includes(word));
        sectionCount += Number(!row.hidden);
      }
      section.hidden = sectionCount === 0;
      visible += sectionCount;
    }
    results.hidden = !search.value.trim();
    results.textContent = visible ? `${visible} setting${visible === 1 ? '' : 's'} found` : 'No settings match your search.';
    for (const button of categories) button.setAttribute('aria-pressed', String(button.dataset.settingsCategory === category));
    content.scrollTop = 0;
  }

  function render(writeValues = true) {
    const available = Boolean(data) && !busy;
    const availableIntelligence = intelligenceAvailable();
    scope.disabled = !available;
    reset.disabled = !available || (workspace()
      ? !Object.keys(data.overrides).length && !draft().size
      : fields.every(({ key, field }) => data.global[key] === field.default && !draft().has(key)));
    reset.textContent = workspace() ? 'Clear Workspace Overrides' : 'Restore editor defaults';
    byId('settings-scope-note').textContent = workspace()
      ? 'Changes here override global settings for this workspace.'
      : 'Applies when a workspace has no override.';
    save.disabled = !available || !draft().size;
    close.disabled = busy;
    close.textContent = dirty() ? 'Discard changes and close' : 'Close';
    pending.textContent = [drafts.global.size && 'Global', drafts.workspace.size && 'This workspace']
      .filter(Boolean).map((value, index) => index ? ' and ' + value : 'Unsaved editor settings · ' + value).join('');
    theme.disabled = busy;
    themeReset.disabled = busy || theme.value === defaultTheme;
    for (const button of [revoke, exportButton, resetLayoutButton, extensionButton, storeButton, about, defaultApps]) button.disabled = busy;
    installUpdate.disabled = busy || api.windowsInstaller !== 'signed';
    for (const button of intelligenceButtons) button.disabled = busy || !availableIntelligence;
    byId('settings-intelligence-state').textContent = availableIntelligence ? '' :
      'Enable VOKRI Intelligence in the status bar to manage live settings.';
    for (const { key, field, input, restore, row, note } of fields) {
      input.disabled = !available;
      const changed = draft().has(key);
      const inherited = data && inherits(key);
      const restoringInheritance = changed && draft().get(key) === null;
      const value = data ? changed ? draft().get(key) ?? data.global[key] : currentValue(key) : field.default;
      const alreadyRestored = workspace() ? restoringInheritance || (inherited && !changed) : value === field.default;
      restore.disabled = !available || alreadyRestored;
      restore.title = workspace() ? 'Inherit the global setting' : 'Restore the default value';
      if (writeValues) {
        if (input.type === 'checkbox') input.checked = value;
        else input.value = Number.isNaN(value) ? '' : value;
      }
      row.toggleAttribute('data-pending', changed);
      const state = workspace() && data ? (inherited && !changed || restoringInheritance
        ? 'Inherits global · ' : 'Workspace override · Global ') + formatValue(field, data.global[key]) : 'Global';
      note.textContent = ['Default · ' + formatValue(field, field.default), state, changed && 'Unsaved'].filter(Boolean).join(' · ');
    }
  }

  async function operation(action) {
    if (busy) return;
    busy = true;
    render(false);
    try { await action(); }
    catch (error) { tell(errorText(error), true); }
    finally { busy = false; render(false); }
  }

  async function showTrust(id) {
    const trusted = id && await api.workspaceTrust(id);
    trustStatus.textContent = !id ? 'Open a workspace to review its execution trust.' : trusted
      ? 'Workspace execution is trusted.' : 'VOKRI Code will ask before running workspace code.';
    revoke.hidden = !trusted;
  }

  function restoreField(key) {
    if (workspace()) {
      if (inherits(key)) draft().delete(key);
      else draft().set(key, null);
    } else if (data.global[key] === editorFields[key].default) draft().delete(key);
    else draft().set(key, editorFields[key].default);
  }

  for (const { key, field, input, restore } of fields) {
    input.oninput = () => {
      const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? input.valueAsNumber : input.value;
      if (Object.is(currentValue(key), value)) draft().delete(key);
      else draft().set(key, value);
      input.setAttribute('aria-invalid', String(!validEditorValue(key, value)));
      tell('');
      render(false);
    };
    restore.onclick = () => {
      restoreField(key);
      input.removeAttribute('aria-invalid');
      tell('');
      render();
      input.focus();
    };
  }

  reset.onclick = () => {
    for (const { key, input } of fields) {
      restoreField(key);
      input.removeAttribute('aria-invalid');
    }
    tell('');
    render();
    if (!save.disabled) save.focus();
  };
  scope.onchange = () => {
    for (const { input } of fields) input.removeAttribute('aria-invalid');
    tell('');
    render();
  };
  form.onsubmit = event => {
    event.preventDefault();
    if (!data || !draft().size || busy) return;
    const invalid = fields.find(({ key }) => draft().has(key) && draft().get(key) !== null && !validEditorValue(key, draft().get(key)));
    if (invalid) {
      const { field, input } = invalid;
      chooseCategory('editor');
      input.setAttribute('aria-invalid', 'true');
      tell(field.label + ` must be a whole number from ${field.min} to ${field.max}.`, true);
      input.focus();
      return;
    }
    void operation(async () => {
      data = await api.setEditorSettings(getProject()?.id, scope.value, Object.fromEntries(draft()));
      draft().clear();
      apply(data.effective);
      render();
      tell('Settings saved.');
    });
  };
  function saveTheme(value) {
    void operation(async () => {
      await changeTheme(value);
      tell('Theme saved.');
    });
  }
  theme.onchange = () => saveTheme(theme.value);
  themeReset.onclick = () => saveTheme(defaultTheme);
  resetLayoutButton.onclick = () => void operation(async () => {
    await resetLayout();
    tell('Workbench layout reset.');
  });
  revoke.onclick = () => void operation(async () => {
    const { id } = getProject();
    await api.revokeTrust(id);
    await showTrust(id);
    tell('Workspace trust revoked.');
  });
  exportButton.onclick = () => void operation(async () => {
    tell(await api.exportSettings() ? 'Settings exported.' : 'Export canceled.');
  });

  function navigate(action) {
    if (busy) return;
    if (dirty()) {
      tell('Save or discard your editor changes before leaving Settings.');
      (save.disabled ? scope : save).focus();
      return;
    }
    dialog.close();
    Promise.resolve().then(action).catch(report);
  }
  extensionButton.onclick = () => navigate(manageExtensions);
  storeButton.onclick = () => navigate(openStore);
  for (const button of intelligenceButtons) {
    button.onclick = () => navigate(() => openIntelligence(button.dataset.intelligenceSettings));
  }
  about.onclick = () => void operation(api.about);
  defaultApps.onclick = () => void operation(api.windowsDefaultApps);
  installUpdate.onclick = () => {
    if (dirty()) {
      tell('Save or discard your editor changes before installing an update.');
      (save.disabled ? scope : save).focus();
      return;
    }
    void operation(api.windowsInstallUpdate);
  };
  close.onclick = () => dialog.close();
  dialog.oncancel = event => {
    if (busy || dirty()) event.preventDefault();
    if (!busy && dirty()) {
      tell('Save or discard your editor changes before closing Settings.');
      close.focus();
    }
  };

  function chooseCategory(next) {
    category = next;
    search.value = '';
    filter();
  }
  for (const button of categories) button.onclick = () => chooseCategory(button.dataset.settingsCategory);
  search.oninput = () => { category = 'all'; filter(); };
  search.onkeydown = event => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    dialog.requestClose();
  };

  return {
    async show(next = 'all') {
      if (dialog.open || busy) return;
      const id = getProject()?.id;
      data = undefined;
      drafts.global.clear();
      drafts.workspace.clear();
      for (const { input } of fields) input.removeAttribute('aria-invalid');
      scope.options[1].disabled = !id;
      scope.value = id ? 'workspace' : 'global';
      revoke.hidden = true;
      trustStatus.textContent = '';
      chooseCategory(next);
      tell('Loading settings…');
      dialog.showModal();
      search.focus();
      await operation(async () => {
        data = await api.editorSettings(id);
        render();
        await showTrust(id);
        tell('');
      });
    },
  };
}
