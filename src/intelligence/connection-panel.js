(() => {
  const api = window.intelligenceMock;
  const panel = document.getElementById('connections');
  const list = document.getElementById('connection-list');
  const status = document.getElementById('connection-status');
  const labels = {
    unconfigured: 'No key configured',
    configured: 'Key configured · Provider verification pending',
    'cleanup-required': 'Credential cleanup required',
  };
  const outcomes = {
    stored: 'Key stored in Windows Credential Manager.',
    rotated: 'Key replaced in Windows Credential Manager.',
    available: 'Windows Credential Manager verified the stored key.',
    missing: 'The configured key is missing from Windows Credential Manager.',
    cancelled: 'Action canceled.',
    disconnected: 'Key removed from Windows Credential Manager.',
    cleaned: 'Interrupted credential operation cleaned up.',
  };
  let busy = false;
  let entries = [];

  function control(title, operation, providerId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = title;
    button.disabled = busy;
    button.addEventListener('click', () => void run(operation, providerId));
    return button;
  }

  function render() {
    const rows = entries.map(({ providerId, label, state, verified }) => {
      const row = document.createElement('li');
      const name = document.createElement('h2');
      name.textContent = label;
      const detail = document.createElement('p');
      detail.textContent = state === 'configured' && verified ? 'Key configured · Model access verified this session' : labels[state];
      const actions = document.createElement('div');
      actions.className = 'actions';
      if (state === 'cleanup-required') actions.append(control('Clean up', 'cleanupKey', providerId));
      else actions.append(control(state === 'configured' ? 'Replace key' : 'Add key', 'storeKey', providerId));
      if (state === 'configured') actions.append(control('Check key', 'checkKey', providerId));
      if (state !== 'unconfigured') actions.append(control('Disconnect', 'disconnectKey', providerId));
      row.append(name, detail, actions);
      return row;
    });
    list.replaceChildren(...rows);
  }

  async function run(operation, providerId) {
    if (busy) return;
    busy = true;
    const active = document.activeElement;
    for (const button of list.querySelectorAll('button')) button.disabled = true;
    status.textContent = operation === 'storeKey' ? 'Waiting for the Windows key dialog…' : 'Checking connections…';
    let message;
    try {
      if (operation) {
        const result = await api[operation](providerId);
        message = result.ok ? outcomes[operation === 'cleanupKey' ? 'cleaned' : result.value] : result.message;
      }
      const snapshot = await api.connections();
      if (!snapshot.ok) {
        entries = [];
        message = snapshot.message;
      } else {
        entries = snapshot.value.entries;
        if (!snapshot.value.available) message = 'The Windows credential vault is unavailable on this build.';
      }
    } catch {
      entries = [];
      message = 'The connection operation could not finish.';
    } finally {
      busy = false;
      render();
      status.textContent = message ?? '';
      if (operation && (!document.activeElement || document.activeElement === document.body || document.activeElement === active)) {
        const index = entries.findIndex(entry => entry.providerId === providerId);
        (list.children[index]?.querySelector('button') ?? panel.querySelector('summary')).focus();
      }
    }
  }

  panel.addEventListener('toggle', () => { if (panel.open) void run(); });
  document.addEventListener('intelligence-connection-changed', () => { if (panel.open) void run(); });
})();
