import { permissionLabel } from './extensions/capabilities.cjs';

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function permissionList(permissions) {
  if (!permissions.length) return element('p', 'No runtime permissions requested.');
  const list = element('ul');
  for (const permission of permissions) {
    const item = element('li', permissionLabel(permission));
    if (permission.files) {
      const files = element('ul');
      for (const file of permission.files) files.append(element('li', file));
      item.append(files);
    }
    list.append(item);
  }
  return list;
}

function permissionDiff(changes) {
  if (!changes) return element('p', 'The installed permissions are unavailable. Review all requested permissions for this package.');
  if (!changes.length) return element('p', 'No permission changes.');
  const list = element('ul');
  const labels = { added: 'Added capability', removed: 'Removed capability', changed: 'Changed scope' };
  for (const change of changes) {
    const item = element('li');
    item.append(element('span', `${labels[change.status]} · ${permissionLabel({ capability: change.capability })}`));
    const scope = element('ul');
    for (const file of change.addedFiles) scope.append(element('li', `Added file scope · ${file}`));
    for (const file of change.removedFiles) scope.append(element('li', `Removed file scope · ${file}`));
    if (change.drafts) scope.append(element('li', `Open draft access ${change.drafts}.`));
    if (scope.childElementCount) item.append(scope);
    list.append(item);
  }
  return list;
}

const stateLabels = { enabled: 'Enabled', disabled: 'Disabled', quarantined: 'Quarantined', failed: 'Verification failed' };

export function createExtensionManager({ api, getProject, review, diagnostics, report, errorText }) {
  const byId = id => document.getElementById(id);
  const open = byId('extension-manager-open');
  const dialog = byId('extension-manager');
  const list = byId('extension-manager-list');
  const catalog = byId('extension-manager-catalog');
  const status = byId('extension-manager-status');
  const catalogError = byId('extension-manager-catalog-error');
  const choose = byId('extension-manager-choose');
  const restart = byId('extension-manager-restart');
  const safeMode = byId('extension-manager-safe-mode');
  const details = byId('extension-manager-details');
  const detailHeading = byId('extension-manager-detail-heading');
  const detailBody = byId('extension-manager-detail-body');
  const install = byId('extension-manager-install');
  let request = 0;
  let opening = 0;
  let busy = false;
  let safeStart = false;
  let token;
  let detailOpener;
  let focusAction;

  function discardDetails() {
    if (token) void api.discardExtensionReview(token).catch(() => {});
    token = undefined;
    details.hidden = true;
    catalog.hidden = false;
    detailBody.replaceChildren();
    install.onclick = null;
  }

  function focusCatalog() {
    if (!dialog.open || !details.hidden) return;
    const focused = document.activeElement;
    if (focused !== document.body && focused !== dialog && focused !== detailHeading && !list.contains(focused)) return;
    const row = [...list.children].find(item => item.dataset.extensionId === focusAction?.id);
    const actions = row ? [...row.querySelectorAll('button:not(:disabled)')] : [];
    (actions.find(control => control.dataset.action === focusAction?.action) ?? actions[0] ?? choose).focus();
  }

  async function act(action, interrupt = false) {
    if (busy && !interrupt) return;
    if (!interrupt) busy = true;
    choose.disabled = restart.disabled = true;
    try { await action(); }
    catch (error) { status.textContent = errorText(error); }
    finally {
      if (!interrupt) busy = false;
      choose.disabled = restart.disabled = busy;
      await refresh();
      focusCatalog();
    }
  }

  function action(entry, key, label, callback, { disabled = false, interrupt = false } = {}) {
    const control = element('button', label);
    control.className = 'button';
    control.dataset.action = key;
    control.setAttribute('aria-describedby', 'extension-title-' + entry.id);
    control.disabled = disabled || (busy && !interrupt);
    control.onclick = () => {
      if (busy && !interrupt) return;
      focusAction = { id: entry.id, action: key };
      control.disabled = true;
      void act(() => callback(control), interrupt);
    };
    return control;
  }

  function showDetails({ report: inspection, source, current, update, token: selectedToken }, opener) {
    const { manifest, sha256, inventory } = inspection;
    detailOpener = opener;
    token = selectedToken;
    detailHeading.textContent = selectedToken ? `Review ${manifest.displayName}` : manifest.displayName;
    const metadata = element('dl');
    const entries = [
      ['Source', source], ['Extension ID', manifest.id], ['Version', manifest.version], ['Publisher', 'Unverified'], ['SHA-256', sha256],
    ];
    if (current) entries.push(['Installed version', current.version], ['Installed SHA-256', current.sha256]);
    for (const [name, value] of entries) metadata.append(element('dt', name), element('dd', value));
    const files = element('ul');
    for (const item of inventory) {
      const row = element('li', `${item.path} · ${item.bytes} bytes`);
      row.append(element('code', item.sha256));
      files.append(row);
    }
    detailBody.replaceChildren(element('p', manifest.description), metadata,
      element('h4', 'Requested permissions'), permissionList(manifest.permissions));
    if (update) {
      detailBody.append(element('h4', 'Permission changes'), permissionDiff(update.permissions));
      if (manifest.schemaVersion === 2 && current.sha256 !== sha256) {
        detailBody.append(element('p', 'Review permissions again before activating this package.'));
      }
    }
    if (selectedToken && current?.permissions) detailBody.append(element('h4', 'Installed permissions'), permissionList(current.permissions));
    detailBody.append(element('h4', 'Package contents'), files);
    const snippets = manifest.contributes.snippets?.length ?? 0;
    const themes = manifest.contributes.themes?.length ?? 0;
    if (snippets || themes) {
      const contributions = [];
      if (snippets) contributions.push(snippets === 1 ? '1 snippet' : `${snippets} snippets`);
      if (themes) contributions.push(themes === 1 ? '1 editor palette' : `${themes} editor palettes`);
      detailBody.append(element('p', contributions.join(' · ')));
    }
    const identical = current?.sha256 === sha256;
    const downgrade = update?.direction === 'downgrade';
    install.hidden = !selectedToken || identical || current?.pinned === true;
    install.disabled = false;
    install.textContent = !update ? 'Install Package' : downgrade ? 'Install Older Version' :
      update.direction === 'replacement' ? 'Replace Package' : 'Install Update';
    install.onclick = () => {
      if (!token || busy) return;
      const approved = token;
      token = undefined;
      install.disabled = true;
      void act(async () => {
        const installed = await api.installExtension(approved, downgrade);
        status.textContent = `${installed.displayName ?? installed.id} ${installed.version} installed. ${stateLabels[installed.state]}.`;
        discardDetails();
        focusAction = { id: installed.id, action: 'enable' };
      });
    };
    if (selectedToken) {
      if (identical) status.textContent = 'This exact package is already installed.';
      else if (current?.pinned) status.textContent = `Version ${current.version} is pinned. Unpin it before changing packages.`;
      else if (downgrade) status.textContent = `This package replaces version ${current.version} with older version ${manifest.version}. It starts disabled.`;
      else if (update?.direction === 'replacement') status.textContent = 'This package has the same version and different bytes. It starts disabled.';
      else status.textContent = 'Review the package before installing. The new version starts disabled.';
    }
    catalog.hidden = true;
    details.hidden = false;
    detailHeading.focus();
  }

  function back() {
    discardDetails();
    if (detailOpener?.isConnected && !detailOpener.disabled) detailOpener.focus();
    else {
      detailHeading.focus();
      focusCatalog();
    }
    detailOpener = undefined;
  }

  function render(snapshot, project) {
    safeStart = snapshot.safeStart;
    safeMode.hidden = !safeStart;
    restart.textContent = safeStart ? 'Restart with Extensions' : 'Restart in Safe Mode';
    restart.disabled = busy;
    const selected = document.activeElement;
    if (selected.dataset.action && list.contains(selected)) {
      focusAction = { id: selected.closest('[data-extension-id]').dataset.extensionId, action: selected.dataset.action };
    }
    const rows = document.createDocumentFragment();
    catalogError.hidden = !snapshot.catalogError;
    catalogError.textContent = snapshot.catalogError ?? '';
    byId('extension-manager-empty').hidden = Boolean(snapshot.catalogError) || snapshot.catalog.length > 0;
    for (const entry of snapshot.catalog) {
      const row = element('li');
      row.dataset.extensionId = entry.id;
      const title = element('h3', entry.displayName ?? entry.id);
      title.id = 'extension-title-' + entry.id;
      row.setAttribute('aria-labelledby', title.id);
      const session = snapshot.sessions.find(item => item.id === entry.id && item.digest === entry.sha256);
      const failed = snapshot.failures.some(item => item.id === entry.id && item.digest === entry.sha256);
      const state = session ? (session.ready ? 'Active for this session' : 'Activating…') :
        failed && entry.enabled ? 'Stopped after a host failure' : stateLabels[entry.state];
      const type = entry.executable === undefined ? 'Local ZIP' : entry.executable ? 'Executable' : 'Declarative';
      row.append(title, element('p', `${entry.id} · ${entry.version} · ${type}`), element('p', state));
      if (entry.pinned) row.append(element('p', 'Version pinned'));
      if (entry.state === 'failed') row.append(element('p', 'The stored package could not be verified. Restore a previous version or uninstall it.'));
      if (entry.executable && entry.enabled && !session && !safeStart) {
        if (!project) row.append(element('p', 'Open a workspace to review executable permissions.'));
        else if (!snapshot.supported) row.append(element('p', 'Activation requires a verified Windows x64 build.'));
      }
      const controls = element('div');
      controls.className = 'extension-actions';
      const change = (key, label, outcome, interrupt = false) => action(entry, key, label, async () => {
        const result = await api.changeExtension(entry.id, entry.sha256, key);
        status.textContent = result === null ? 'Action canceled.' : outcome;
      }, { interrupt });
      if (entry.state !== 'failed') controls.append(action(entry, 'inspect', 'Inspect', async control => {
        const epoch = opening;
        const inspection = await api.inspectInstalledExtension(entry.id, entry.sha256);
        if (dialog.open && epoch === opening) showDetails({ report: inspection, source: 'Local ZIP package' }, control);
      }));
      if (entry.state === 'disabled') controls.append(change('enable', 'Enable', 'Extension enabled.'));
      if (entry.enabled) controls.append(change('disable', 'Disable', 'Extension disabled.', true));
      if (entry.pinned) controls.append(change('unpin', 'Unpin Version', 'Version unpinned.'));
      else if (entry.state !== 'failed') controls.append(change('pin', 'Pin Version', `Version ${entry.version} pinned.`));
      if (entry.executable && entry.enabled) {
        controls.append(session ? action(entry, 'revoke', 'Revoke Access', async () => {
          await api.revokeExtension(project.id, entry.id);
          status.textContent = 'Access revoked.';
        }, { interrupt: true }) : action(entry, 'activate', 'Review Permissions', async () => {
          const allowed = await api.activateExtension(project.id, entry.id, entry.sha256);
          status.textContent = allowed ? 'Permissions granted for this session.' : 'Activation canceled.';
        }, { disabled: !project || !snapshot.supported }));
      }
      if (entry.state === 'quarantined') controls.append(change('clear-quarantine', 'Clear Quarantine', 'Quarantine cleared. Extension disabled.'));
      else if (entry.state !== 'failed') controls.append(change('quarantine', 'Quarantine', 'Extension quarantined.'));
      if (entry.rollback && !entry.pinned) controls.append(change('restore', 'Restore Previous Version', `Version ${entry.rollback.version} restored and disabled.`));
      controls.append(change('uninstall', 'Uninstall', 'Extension uninstalled.'));
      for (const command of session?.commands ?? []) {
        controls.append(action(entry, command.registrationId, 'Run ' + command.title, async () => {
          await api.extensionCommand(project.id, entry.id, command.registrationId);
          status.textContent = 'Command completed.';
        }, { disabled: !session.ready }));
      }
      row.append(controls);
      for (const proposal of session?.proposals ?? []) {
        row.append(element('p', proposal.path + ' · ' + proposal.explanation), action(entry, proposal.proposalId, 'Review Edit', async () => {
          dialog.close();
          await review(entry.id, proposal.proposalId);
        }));
      }
      rows.append(row);
    }
    list.replaceChildren(rows);
    focusCatalog();
  }

  async function refresh() {
    const project = getProject();
    const id = ++request;
    const includeCatalog = dialog.open;
    if (!project && !includeCatalog) return;
    const current = () => request === id && project === getProject();
    try {
      const snapshot = await api.extensionRuntime(project?.id, includeCatalog);
      if (!current()) return;
      if (includeCatalog && dialog.open) render(snapshot, project);
      if (project) await diagnostics(snapshot.sessions, current);
    } catch (error) {
      if (!current()) return;
      if (includeCatalog && dialog.open) {
        list.replaceChildren();
        status.textContent = errorText(error);
      } else report(error);
    }
  }

  choose.onclick = () => {
    const epoch = opening;
    void act(async () => {
      const selected = await api.selectExtensionPackage();
      if (!selected) return;
      if (!dialog.open || epoch !== opening) {
        await api.discardExtensionReview(selected.token);
        return;
      }
      showDetails(selected, choose);
    });
  };
  restart.onclick = () => void act(() => api.restartExtensions(!safeStart));
  byId('extension-manager-back').onclick = back;
  byId('extension-manager-close').onclick = () => dialog.close();
  open.onclick = () => {
    ++opening;
    focusAction = undefined;
    status.textContent = '';
    restart.disabled = true;
    dialog.showModal();
    void refresh();
  };
  dialog.oncancel = event => {
    if (details.hidden) return;
    event.preventDefault();
    back();
  };
  dialog.onclose = () => {
    if (dialog.open) return;
    ++opening;
    discardDetails();
    void refresh();
  };
  api.onExtensionRuntimeChanged(() => void refresh());
  return {
    refresh,
    reset() {
      dialog.close();
      discardDetails();
      list.replaceChildren();
      void refresh();
    },
  };
}
