const proofLabels = {
  matches: 'Staged source bytes match the latest full test pass.',
  historical: 'Historical · the recorded test does not verify this staged snapshot.',
  unverified: 'The latest full test run did not establish a matching pass.',
  unavailable: 'Staged verification is unavailable for this snapshot.',
  none: 'Run the full test suite to compare its inputs with the staged snapshot.',
};

export function createChangeLensPanel({ api, mutate, errorText, getDirty }) {
  const byId = id => document.getElementById(id);
  const panel = byId('change-panel');
  const status = byId('git-status');
  const proof = byId('git-proof');
  const draft = byId('git-drafts');
  const staged = byId('git-staged');
  const working = byId('git-working');
  const history = byId('git-history');
  const branch = byId('git-branches');
  const newBranch = byId('git-branch-name');
  const diff = byId('git-patch');
  const title = byId('git-patch-title');
  const refreshButton = byId('git-refresh');
  const fileAction = byId('git-stage-action');
  const reviewButton = byId('git-review');
  const commitBox = byId('git-commit-box');
  const commitButton = byId('git-commit');
  const message = byId('git-commit-message');
  const switchButton = byId('git-switch');
  const createButton = byId('git-create-branch');
  let project;
  let snapshot;
  let selected;
  let patch;
  let review;
  let busy = false;
  let loading = false;
  let blocked = false;
  let generation = 0;
  let feedback = '';

  function fileKey(file) {
    const normalized = file.replaceAll('\\', '/');
    return project?.caseInsensitivePaths ? normalized.toLowerCase() : normalized;
  }

  function sync() {
    const dirty = getDirty();
    const dirtySelection = selected?.side === 'working' && dirty.some(file => fileKey(file) === fileKey(selected.file));
    const writable = snapshot?.writable && !busy && !loading && !blocked;
    const stagedCount = snapshot?.rows?.filter(row => !row.conflict && ![' ', '?'].includes(row.index)).length ?? 0;
    refreshButton.disabled = !project || busy;
    reviewButton.disabled = !writable || !stagedCount || snapshot.branch === 'Detached HEAD';
    fileAction.hidden = !selected;
    fileAction.textContent = selected?.side === 'staged' ? 'Unstage file' : 'Stage file';
    fileAction.disabled = !writable || !patch || patch.clipped || selected?.conflict || dirtySelection;
    commitBox.hidden = !review;
    commitButton.disabled = !writable || !review || !message.value.trim();
    createButton.disabled = !writable || !snapshot.tip || !newBranch.value.trim();
    switchButton.disabled = !writable || !branch.value || branch.value === snapshot.branch || Boolean(snapshot.rows.length || dirty.length);
    draft.textContent = dirtySelection ? 'Save this draft and refresh its diff before staging.' : dirty.length ?
      `${dirty.length} unsaved draft(s) are outside the staged snapshot.` : '';
    draft.hidden = !draft.textContent;
    const result = review?.verification ?? snapshot?.verification;
    proof.textContent = result ? proofLabels[result.state] : '';
    proof.title = result?.testRevision ? 'Test revision ' + result.testRevision + '\nStaged revision ' + (result.stagedRevision ?? 'unavailable') : '';
    proof.dataset.state = result?.state ?? '';
  }

  function render() {
    const oldBranch = branch.value;
    branch.replaceChildren(new Option('Choose a branch', ''));
    for (const name of snapshot?.branches ?? []) branch.append(new Option(name, name));
    branch.value = snapshot?.branches?.includes(oldBranch) ? oldBranch : '';
    staged.replaceChildren();
    working.replaceChildren();
    for (const row of snapshot?.rows ?? []) {
      const groups = [];
      if (!row.conflict && ![' ', '?'].includes(row.index)) groups.push([staged, 'staged', row.index]);
      if (row.working !== ' ' || row.conflict) groups.push([working, 'working', row.conflict ? 'Conflict' : row.working]);
      for (const [list, side, mark] of groups) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = row.path + ' · ' + mark;
        button.className = 'diagnostic-link';
        button.disabled = row.conflict;
        button.setAttribute('aria-pressed', String(selected?.file === row.path && selected.side === side));
        button.onclick = () => void showDiff(row, side);
        li.append(button);
        list.append(li);
      }
    }
    history.replaceChildren(...(snapshot?.history ?? []).map(item => {
      const li = document.createElement('li');
      li.textContent = item.short + ' · ' + item.subject;
      li.title = item.id;
      return li;
    }));
    status.textContent = feedback || snapshot?.message || (snapshot ?
      `${snapshot.branch} · ${snapshot.tip ? snapshot.tip.slice(0, 10) : 'First commit pending'}${snapshot.clipped ? ' · Changed paths clipped' : ''}${snapshot.writable ? '' : ' · Read-only review'}` : 'Reading Git status…');
    status.title = snapshot?.root ?? '';
    title.textContent = review ? `Commit review · ${review.branch} · ${review.files.length} staged path(s)` : selected ?
      (selected.side === 'staged' ? 'Staged · ' : 'Working · ') + selected.file : 'Select a changed file to review its diff.';
    diff.textContent = review ? review.files.join('\n') + '\n\n' + review.text : patch ?
      (patch.text || 'Git returned no textual diff.') + (patch.clipped ? '\n\nDiff clipped at the review limit.' : '') : '';
    sync();
  }

  async function load() {
    if (!project || busy) return;
    const request = ++generation;
    const file = selected;
    loading = true;
    sync();
    try {
      const result = await api.gitStatus(project.id);
      if (request !== generation) return;
      loading = false;
      if (snapshot?.id !== result.id) review = undefined;
      snapshot = result;
      selected = patch = undefined;
      render();
      const row = file && result.rows?.find(row => row.path === file.file);
      if (row && !review && (file.side === 'working' ? row.working !== ' ' : ![' ', '?'].includes(row.index))) void showDiff(row, file.side);
    } catch (error) {
      if (request !== generation) return;
      loading = false;
      snapshot = selected = patch = review = undefined;
      feedback = errorText(error);
      render();
    }
  }

  async function showDiff(row, side) {
    if (busy || loading || !snapshot?.id) return;
    const request = ++generation;
    selected = { file: row.path, side, conflict: row.conflict };
    review = patch = undefined;
    feedback = '';
    render();
    try {
      const result = await api.gitDiff(project.id, snapshot.id, row.path, side);
      if (request === generation) { patch = result; render(); }
    } catch (error) {
      if (request === generation) { feedback = errorText(error); render(); }
    }
  }

  async function reviewCommit() {
    if (reviewButton.disabled) return;
    const request = ++generation;
    selected = patch = review = undefined;
    feedback = '';
    render();
    try {
      const result = await api.gitReview(project.id, snapshot.id);
      if (request === generation) { review = result; render(); message.focus(); }
    } catch (error) {
      if (request === generation) { feedback = errorText(error); render(); }
    }
  }

  async function write(action, details) {
    if (busy || loading || blocked || !snapshot?.writable) return;
    ++generation;
    const scope = project;
    busy = true;
    feedback = '';
    sync();
    try {
      const result = await mutate(action, { snapshot: snapshot.id, ...details });
      if (project !== scope || !result) return;
      if (result.commit) { feedback = 'Committed ' + result.commit.slice(0, 10); message.value = ''; }
      if (action === 'create') newBranch.value = '';
      review = selected = patch = undefined;
    } catch (error) {
      if (project === scope) feedback = errorText(error);
    } finally {
      if (project === scope) { busy = false; render(); void load(); }
    }
  }

  refreshButton.onclick = () => { feedback = ''; void load(); };
  reviewButton.onclick = () => void reviewCommit();
  fileAction.onclick = () => { if (!fileAction.disabled) void write('stage', { ...selected, diff: patch.id }); };
  commitButton.onclick = () => { if (!commitButton.disabled) void write('commit', { message: message.value }); };
  createButton.onclick = () => void write('create', { branch: newBranch.value.trim() });
  switchButton.onclick = () => void write('switch', { branch: branch.value });
  message.oninput = newBranch.oninput = branch.onchange = sync;
  window.addEventListener('focus', () => { if (!panel.hidden) void load(); });

  return {
    reset(next) {
      ++generation;
      project = next;
      snapshot = selected = patch = review = undefined;
      feedback = message.value = newBranch.value = '';
      busy = loading = false;
      render();
      if (!panel.hidden) void load();
    },
    show(visible) { panel.hidden = !visible; if (visible) void load(); },
    sync(value) { blocked = value; sync(); },
  };
}
