export function createProblemsPanel({ api, apply, jump, report, errorText }) {
  const byId = id => document.getElementById(id);
  const pane = byId('problems-panel');
  const list = byId('problem-list');
  const status = byId('problems-status');
  const badge = byId('problems-count');
  const retry = byId('problems-retry');
  const documents = new Map();

  function current(entry, version) {
    return documents.get(entry.tab.id) === entry && entry.tab.version === version;
  }

  function problemRow(entry, issue) {
    const { tab, version } = entry;
    const line = tab.state.doc.lineAt(issue.from);
    const column = issue.from - line.from + 1;
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'problem-row';
    const severity = document.createElement('span');
    severity.className = 'problem-severity';
    severity.dataset.severity = issue.severity;
    severity.textContent = issue.severity === 'warning' ? 'Warning' : 'Error';
    const message = document.createElement('span');
    message.className = 'problem-message';
    message.textContent = issue.message;
    const location = document.createElement('span');
    location.className = 'problem-location';
    location.textContent = 'Ln ' + line.number + ', Col ' + column;
    button.title = tab.path + ':' + line.number + ':' + column + ' — ' + issue.message;
    button.append(severity, message, location);
    button.onclick = () => {
      if (!current(entry, version)) return;
      jump({
        path: tab.path, offset: issue.from, length: issue.to - issue.from,
      }, { documentId: tab.id, version, isCurrent: () => current(entry, version) }).catch(report);
    };
    row.append(button);
    return row;
  }

  function render() {
    let count = 0;
    let pending = 0;
    let unavailable = 0;
    for (const entry of documents.values()) {
      count += entry.issues.length + (entry.omitted ?? 0);
      pending += Number(entry.status === 'pending');
      unavailable += Number(entry.status === 'unavailable');
    }
    badge.textContent = count;
    badge.hidden = count === 0;
    retry.hidden = pane.hidden || unavailable === 0;
    if (pane.hidden) return;

    const summary = [];
    if (pending) summary.push('Checking ' + pending + (pending === 1 ? ' file…' : ' files…'));
    if (count) summary.push(count + (count === 1 ? ' syntax problem' : ' syntax problems'));
    if (unavailable) summary.push(unavailable + ' unavailable');
    status.textContent = summary.join(' · ') || (documents.size ? 'No syntax problems.' :
      'Open a JavaScript or TypeScript file to check syntax.');

    const fragment = document.createDocumentFragment();
    for (const entry of documents.values()) {
      if (!entry.issues.length && entry.status !== 'unavailable') continue;
      const group = document.createElement('li');
      const heading = document.createElement('h3');
      heading.className = 'problem-file';
      heading.textContent = heading.title = entry.tab.path;
      group.append(heading);
      if (entry.status === 'unavailable') {
        const explanation = document.createElement('p');
        explanation.className = 'problem-note';
        explanation.textContent = entry.error;
        group.append(explanation);
      } else {
        const rows = document.createElement('ul');
        rows.append(...entry.issues.map(issue => problemRow(entry, issue)));
        if (entry.omitted) {
          const note = document.createElement('li');
          note.className = 'problem-note';
          note.textContent = entry.omitted + ' more syntax problems in this file.';
          rows.append(note);
        }
        group.append(rows);
      }
      fragment.append(group);
    }
    list.replaceChildren(fragment);
  }

  function schedule(entry, delay) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (!entry.running) void inspect(entry);
    }, delay);
  }

  async function inspect(entry) {
    const { tab } = entry;
    const version = tab.version;
    entry.running = true;
    try {
      const result = await api.syntax(tab.projectId, tab.path, tab.state.doc.toString());
      if (!current(entry, version)) return;
      entry.status = 'ready';
      entry.version = version;
      entry.issues = result.issues;
      entry.omitted = result.omitted;
      apply(tab, result.issues);
    } catch (error) {
      if (!current(entry, version)) return;
      entry.status = 'unavailable';
      entry.issues = [];
      entry.omitted = 0;
      entry.error = errorText(error);
    } finally {
      entry.running = false;
      if (documents.get(tab.id) === entry) {
        if (tab.version !== version && entry.timer === undefined) schedule(entry, 0);
        render();
      }
    }
  }

  function refresh(entry, delay) {
    const needsRender = entry.status !== 'pending';
    entry.issues = [];
    entry.omitted = 0;
    entry.status = 'pending';
    schedule(entry, delay);
    if (needsRender) render();
  }

  retry.onclick = () => {
    for (const entry of documents.values()) {
      if (entry.status === 'unavailable') refresh(entry, 0);
    }
  };

  return {
    render,
    track(tab) {
      if (!tab.language) return;
      const entry = { tab, issues: [] };
      documents.set(tab.id, entry);
      refresh(entry, 0);
    },
    changed(tab) {
      const entry = documents.get(tab.id);
      if (entry) refresh(entry, 180);
    },
    remove(tab) {
      clearTimeout(documents.get(tab.id)?.timer);
      documents.delete(tab.id);
      render();
    },
    reset() {
      for (const entry of documents.values()) clearTimeout(entry.timer);
      documents.clear();
      render();
    },
  };
}
