import { permissionLabel } from './extensions/capabilities.cjs';

export function createExtensionPermissions({ api, getProject, review, diagnostics, report, errorText }) {
  const byId = id => document.getElementById(id);
  const button = byId('extension-permissions');
  const dialog = byId('extension-permissions-dialog');
  const list = byId('extension-permissions-list');
  const status = byId('extension-permissions-status');
  let request = 0;
  let busy = false;

  async function act(action, interrupt) {
    if (busy && !interrupt) return;
    if (!interrupt) busy = true;
    try { await action(); }
    catch (error) { status.textContent = errorText(error); report(error); }
    finally { if (!interrupt) busy = false; await refresh(); }
  }

  function action(label, callback, disabled = false, interrupt = false) {
    const control = document.createElement('button');
    control.className = 'button';
    control.textContent = label;
    control.disabled = disabled || (busy && !interrupt);
    control.onclick = () => {
      if (busy && !interrupt) return;
      control.disabled = true;
      void act(callback, interrupt);
    };
    return control;
  }

  function render(snapshot, project) {
    list.replaceChildren();
    for (const extension of snapshot.catalog) {
      const row = document.createElement('li');
      const title = document.createElement('h3');
      title.textContent = extension.displayName;
      const detail = document.createElement('p');
      detail.textContent = extension.id + ' · ' + extension.version + ' · ' + extension.sha256.slice(0, 12);
      detail.title = extension.sha256;
      const session = snapshot.sessions.find(item => item.id === extension.id);
      const state = document.createElement('p');
      const failed = snapshot.failures.some(item => item.id === extension.id && item.digest === extension.sha256);
      state.textContent = session ? (session.ready ? 'Active for this session' : 'Activating…') :
        failed && extension.state === 'enabled' ? 'Stopped after a host failure' : extension.state;
      const scopes = document.createElement('ul');
      for (const permission of extension.permissions) {
        const item = document.createElement('li');
        item.textContent = permissionLabel(permission) +
          (permission.files ? ' · ' + permission.files.join(', ') : '');
        scopes.append(item);
      }
      row.append(title, detail, state, scopes, session ?
        action('Revoke Access', async () => {
          await api.revokeExtension(project.id, extension.id);
          status.textContent = 'Access revoked.';
        }, false, true) :
        action('Review Permissions', async () => {
          const allowed = await api.activateExtension(project.id, extension.id, extension.sha256);
          status.textContent = allowed ? 'Permissions granted for this session.' : 'Activation canceled.';
        }, !extension.enabled || !snapshot.supported));
      for (const command of session?.commands ?? []) {
        row.append(action('Run ' + command.title, async () => {
          await api.extensionCommand(project.id, extension.id, command.registrationId);
          status.textContent = 'Command completed.';
        }, !session.ready));
      }
      for (const proposal of session?.proposals ?? []) {
        const explanation = document.createElement('p');
        explanation.textContent = proposal.path + ' · ' + proposal.explanation;
        row.append(explanation, action('Review Edit', async () => {
          dialog.close();
          await review(extension.id, proposal.proposalId);
        }));
      }
      list.append(row);
    }
  }

  async function refresh() {
    const project = getProject();
    const id = ++request;
    if (!project) return;
    try {
      const snapshot = await api.extensionRuntime(project.id);
      const current = () => request === id && project === getProject();
      if (!current()) return;
      render(snapshot, project);
      await diagnostics(snapshot.sessions, current);
      if (!current()) return;
      if (!snapshot.catalog.length) status.textContent = 'No executable extensions are installed.';
      else if (!snapshot.supported) status.textContent = 'Activation requires a verified Windows x64 build and a session started with extensions enabled.';
    } catch (error) {
      if (request === id && project === getProject()) report(error);
    }
  }

  button.onclick = () => {
    status.textContent = '';
    dialog.showModal();
    void refresh();
  };
  byId('extension-permissions-close').onclick = () => dialog.close();
  api.onExtensionRuntimeChanged(() => void refresh());
  return {
    refresh,
    reset() {
      ++request;
      dialog.close();
      list.replaceChildren();
      void refresh();
    },
  };
}
