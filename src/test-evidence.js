export function createTestEvidence(api, onChange) {
  const strip = document.getElementById('test-evidence');
  const goal = document.getElementById('workstream-goal');
  const end = document.getElementById('workstream-end');
  const status = document.getElementById('test-revision');
  const check = document.getElementById('test-recheck');
  let project;
  let edits = 0;
  let evidence;
  let checking;

  function syncGoal() {
    end.hidden = !goal.value.trim();
    end.disabled = goal.disabled;
  }

  function render() {
    const revision = evidence?.revision?.slice(0, 10);
    const suffix = revision ? ' · ' + revision : '';
    const description = {
      observed: (evidence?.retry ? 'Retry observed' : 'Workspace inputs observed') + suffix,
      historical: 'Historical · workspace inputs changed' + suffix,
      unavailable: 'Workspace revision unavailable',
    };
    const pending = evidence && checking === evidence;
    status.dataset.freshness = evidence?.freshness ?? '';
    status.textContent = evidence?.outcome === 'cancelled' ? 'Run canceled' :
      pending ? 'Checking workspace inputs…' : evidence ? description[evidence.freshness] :
        document.getElementById('run-panel').dataset.mode === 'tasks' ? 'Run a task to capture a workspace revision.' :
          'Run tests to capture a workspace revision.';
    status.title = evidence ? [evidence.goal ?? evidence.taskId, evidence.revision, evidence.fileCount + ' captured files'].filter(Boolean).join('\n') : '';
    check.hidden = evidence?.freshness !== 'observed';
    check.disabled = Boolean(pending);
    onChange(evidence, pending);
  }

  async function recheck() {
    if (evidence?.freshness !== 'observed' || checking === evidence) return;
    const previous = evidence;
    checking = previous;
    render();
    try {
      const current = await api.runEvidence(project.id, previous.id);
      if (evidence === previous) evidence = current ?? { ...previous, freshness: 'unavailable' };
    } catch {
      if (evidence === previous) evidence = { ...previous, freshness: 'unavailable' };
    } finally {
      if (checking === previous) checking = undefined;
      render();
    }
  }

  check.onclick = () => void recheck();
  goal.addEventListener('input', syncGoal);
  end.onclick = () => {
    goal.value = '';
    syncGoal();
    goal.focus();
  };
  window.addEventListener('focus', () => void recheck());

  return {
    get goal() { return goal.value; },
    get version() { return edits; },
    get latest() { return evidence; },
    setBusy(busy) { goal.disabled = busy; syncGoal(); },
    reset(next) {
      project = next;
      strip.hidden = !next;
      goal.value = '';
      syncGoal();
      evidence = undefined;
      edits = 0;
      render();
    },
    clear() {
      evidence = undefined;
      render();
    },
    changed() {
      edits++;
      if (evidence?.freshness !== 'observed') return;
      evidence = { ...evidence, freshness: 'historical' };
      render();
    },
    finish(result, version) {
      if (!result || result.workspaceId !== project?.id) return;
      evidence = result.freshness === 'observed' && edits !== version ?
        { ...result, freshness: 'historical' } : result;
      render();
    },
    isCurrent(id) { return evidence?.id === id; },
    recheck,
  };
}
