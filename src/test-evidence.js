export function createTestEvidence(api) {
  const strip = document.getElementById('test-evidence');
  const goal = document.getElementById('workstream-goal');
  const status = document.getElementById('test-revision');
  const check = document.getElementById('test-recheck');
  let project;
  let edits = 0;
  let evidence;
  let checking;

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
        'Run tests to capture a workspace revision.';
    status.title = evidence ? [evidence.goal, evidence.revision, evidence.fileCount + ' captured files'].filter(Boolean).join('\n') : '';
    check.hidden = evidence?.freshness !== 'observed';
    check.disabled = Boolean(pending);
  }

  async function recheck() {
    if (evidence?.freshness !== 'observed' || checking === evidence) return;
    const previous = evidence;
    checking = previous;
    render();
    try {
      const current = await api.testEvidence(project.id, previous.id);
      if (evidence === previous) evidence = current ?? { ...previous, freshness: 'unavailable' };
    } catch {
      if (evidence === previous) evidence = { ...previous, freshness: 'unavailable' };
    } finally {
      if (checking === previous) checking = undefined;
      render();
    }
  }

  check.onclick = () => void recheck();
  window.addEventListener('focus', () => void recheck());

  return {
    get goal() { return goal.value; },
    get version() { return edits; },
    setBusy(busy) { goal.disabled = busy; },
    reset(next) {
      project = next;
      strip.hidden = !next;
      goal.value = '';
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
      if (!evidence || evidence.outcome === 'cancelled' || evidence.freshness === 'historical') return;
      evidence = { ...evidence, freshness: 'historical' };
      render();
    },
    finish(result, version) {
      if (!result || result.workspaceId !== project?.id) return;
      evidence = result.outcome !== 'cancelled' && edits !== version ?
        { ...result, freshness: 'historical' } : result;
      render();
    },
    isCurrent(id) { return evidence?.id === id; },
    recheck,
  };
}
