const outcomes = { passed: 'Passed', failed: 'Failed', cancelled: 'Canceled', empty: 'No tests', blocked: 'Blocked' };

export function createFlightpathPanel({ api, errorText, checkInputs }) {
  const byId = id => document.getElementById(id);
  const panel = byId('flightpath-panel');
  const settings = byId('flightpath-retention');
  const clear = byId('flightpath-clear');
  const check = byId('flightpath-check');
  const status = byId('flightpath-status');
  const list = byId('flightpath-capsules');
  let project;
  let snapshot;
  let evidence;
  let checking;
  let busy = false;
  let refreshPending = false;
  let message = '';

  function capsuleRow(capsule) {
    const row = document.createElement('li');
    row.className = 'flightpath-row';
    const live = evidence?.id === capsule.id;
    const freshness = live ? evidence.freshness : capsule.freshness === 'unavailable' ? 'unavailable' : 'historical';
    row.dataset.freshness = live && checking ? 'checking' : freshness;
    const outcome = document.createElement('strong');
    const label = capsule.kind === 'task' ? 'Task ' + capsule.taskId : capsule.retry ? 'Test retry' : 'Project tests';
    outcome.textContent = label + ' · ' + outcomes[capsule.outcome];
    const revision = document.createElement('span');
    revision.textContent = live && checking ? 'Checking inputs…' : {
      observed: 'Workspace inputs observed', historical: 'Historical', unavailable: 'Revision unavailable',
    }[freshness];
    if (capsule.revision) {
      revision.textContent += ' · ' + capsule.revision.slice(0, 10);
      revision.title = capsule.revision;
    }
    const duration = capsule.durationMs < 1000 ? capsule.durationMs + ' ms' : (capsule.durationMs / 1000).toFixed(1) + ' s';
    const details = document.createElement('span');
    details.textContent = [new Date(capsule.completedAt).toLocaleString(), duration,
      capsule.exitCode === null ? '' : 'Exit ' + capsule.exitCode].filter(Boolean).join(' · ');
    row.append(outcome, revision, details);
    return row;
  }

  function render() {
    settings.disabled = busy || !snapshot;
    settings.textContent = snapshot?.unreadable ? 'Delete unreadable history' : snapshot?.enabled ? 'Turn off and clear' : 'Enable local history';
    clear.hidden = !snapshot?.enabled;
    clear.disabled = busy;
    check.hidden = evidence?.freshness !== 'observed' || !snapshot?.capsules.some(capsule => capsule.id === evidence.id);
    check.disabled = Boolean(checking);
    status.textContent = message || (!snapshot ? 'Loading local history…' : snapshot.unreadable ? 'Local history could not be read.' :
      snapshot.writeFailed ? 'A Run Capsule could not be saved.' : snapshot.enabled ?
        `Local history is on. CEVRA keeps metadata for up to ${snapshot.limit} test and task results.` :
        'Local history is off. Enable it to keep metadata for future test and task results.');
    list.replaceChildren(...(snapshot?.capsules.toReversed().map(capsuleRow) ?? []));
  }

  async function update(action = 'view') {
    if (!project) return;
    if (busy) {
      if (action === 'view') refreshPending = true;
      return;
    }
    const scope = project;
    busy = true;
    message = '';
    render();
    try {
      const result = await api.flightpath(scope.id, action);
      if (project === scope) snapshot = result;
    } catch (error) {
      if (project === scope) message = errorText(error);
    } finally {
      if (project === scope) {
        busy = false;
        render();
        if (refreshPending) {
          refreshPending = false;
          void update();
        }
      }
    }
  }

  settings.onclick = () => void update(snapshot?.enabled || snapshot?.unreadable ? 'disable' : 'enable');
  clear.onclick = () => void update('clear');
  check.onclick = () => void checkInputs();

  return {
    reset(next) {
      project = next;
      snapshot = evidence = checking = undefined;
      busy = refreshPending = false;
      message = '';
      render();
    },
    show(visible) {
      panel.hidden = !visible;
      if (visible) {
        void checkInputs();
        void update();
      }
    },
    refresh() { if (!panel.hidden) void update(); },
    setEvidence(result, pending) {
      evidence = result;
      checking = pending;
      if (!panel.hidden) render();
    },
  };
}
