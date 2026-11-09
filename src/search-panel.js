export function createSearchPanel({ api, getProject, getSnapshots, jump, previewReplace, errorText }) {
  const byId = id => document.getElementById(id);
  const explorer = byId('explorer-content');
  const panel = byId('project-search');
  const toggle = byId('search-toggle');
  const heading = byId('sidebar-heading');
  const input = byId('search-query');
  const caseSensitive = byId('search-case');
  const cancel = byId('search-cancel');
  const status = byId('search-status');
  const results = byId('search-results');
  const replacement = byId('replace-text');
  const preview = byId('preview-replace');
  let generation = 0;
  let timer;
  let running;
  let enabled = false;

  function invalidate() {
    clearTimeout(timer);
    if (running) void api.cancelSearch(running.projectId, running.requestId).catch(() => {});
    running = undefined;
    generation++;
    results.replaceChildren();
    preview.disabled = true;
    preview.onclick = null;
    cancel.disabled = true;
    return generation;
  }

  function render(result, requestId) {
    const fragment = document.createDocumentFragment();
    for (const file of result.files) {
      const group = document.createElement('li');
      const path = document.createElement('h3');
      path.className = 'search-path';
      path.textContent = path.title = file.path;
      const matches = document.createElement('ul');
      for (const match of file.matches) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.className = 'search-match';
        const location = file.path + ':' + match.line + ':' + match.column;
        button.title = location + ' ' + match.preview;
        button.setAttribute('aria-label', location + ' ' + match.preview);
        const line = document.createElement('span');
        line.className = 'search-line';
        line.textContent = String(match.line);
        const preview = document.createElement('span');
        preview.className = 'search-preview';
        preview.textContent = match.preview;
        button.append(line, preview);
        button.onclick = async () => {
          if (generation !== requestId) return;
          try {
            await jump({ ...match, path: file.path }, {
              documentId: file.documentId, version: file.version, revision: file.revision,
              isCurrent: () => generation === requestId,
            });
          } catch (error) {
            if (generation !== requestId) return;
            invalidate();
            enabled = false;
            status.textContent = errorText(error);
          }
        };
        item.append(button);
        matches.append(item);
      }
      group.append(path, matches);
      fragment.append(group);
    }
    results.replaceChildren(fragment);
    const count = result.limited ? 'Showing first ' + result.count : String(result.count);
    const summary = result.count === 0 ? 'No matches' : count + (result.count === 1 ? ' match' : ' matches');
    status.textContent = summary + (result.skipped ? ' · ' + result.skipped + ' skipped' : '');
    preview.disabled = !result.count || result.limited || result.files.length > 64;
    preview.title = preview.disabled && result.count ? 'Narrow the search to preview every match in at most 64 files.' : '';
    preview.onclick = () => {
      if (generation === requestId) previewReplace(result, replacement.value);
    };
  }

  async function search(projectId, requestId, query, matchCase) {
    running = { projectId, requestId };
    try {
      const result = await api.search(projectId, requestId, query, matchCase, getSnapshots());
      if (generation === requestId) render(result, requestId);
    } catch (error) {
      if (generation === requestId) status.textContent = errorText(error);
    } finally {
      if (generation === requestId) {
        running = undefined;
        cancel.disabled = true;
      }
    }
  }

  function refresh(delay = 140) {
    if (panel.hidden) return;
    const project = getProject();
    const requestId = invalidate();
    enabled = Boolean(project && input.value);
    if (!enabled) {
      status.textContent = 'Enter text to search this project.';
      return;
    }
    const query = input.value;
    const matchCase = caseSensitive.checked;
    status.textContent = 'Searching…';
    cancel.disabled = false;
    timer = setTimeout(() => void search(project.id, requestId, query, matchCase), delay);
  }

  function close(focus = false) {
    invalidate();
    enabled = false;
    panel.hidden = true;
    explorer.hidden = false;
    heading.textContent = 'Explorer';
    toggle.setAttribute('aria-pressed', 'false');
    if (focus) toggle.focus();
  }

  function show() {
    if (toggle.disabled) return;
    if (panel.hidden) {
      panel.hidden = false;
      explorer.hidden = true;
      heading.textContent = 'Search';
      toggle.setAttribute('aria-pressed', 'true');
      refresh();
    }
    input.focus();
    input.select();
  }

  toggle.onclick = () => panel.hidden ? show() : close(true);
  input.oninput = () => refresh();
  caseSensitive.onchange = () => refresh(0);
  cancel.onclick = () => {
    invalidate();
    enabled = false;
    status.textContent = 'Search canceled.';
    input.focus();
  };
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      refresh(0);
    }
  });

  return {
    show,
    changed() { if (enabled) refresh(); },
    reset() {
      close();
      input.value = '';
      replacement.value = '';
      caseSensitive.checked = false;
    },
  };
}
