export function createSymbolPicker({ api, semantic, getProject, jump, report, errorText }) {
  const byId = id => document.getElementById(id);
  const dialog = byId('symbols-dialog');
  const input = byId('symbol-query');
  const list = byId('symbol-results');
  const status = byId('symbol-status');
  let generation = 0;
  let timer;
  let running;
  let items = [];
  let selected = -1;

  function reset() {
    clearTimeout(timer);
    if (running) void api.cancelSymbols(running.projectId, running.id).catch(() => {});
    running = undefined;
    items = [];
    selected = -1;
    list.replaceChildren();
    input.removeAttribute('aria-activedescendant');
    input.setAttribute('aria-expanded', 'false');
    return ++generation;
  }

  function close() {
    const id = reset();
    if (dialog.open) dialog.close();
    return id;
  }

  function select(index) {
    list.children[selected]?.setAttribute('aria-selected', 'false');
    selected = index;
    const option = list.children[index];
    option.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
  }

  async function openSymbol(item) {
    const project = getProject();
    const id = close();
    const current = () => id === generation && getProject() === project && semantic.available();
    try {
      await jump(item, {
        documentId: item.documentId, version: item.version, revision: item.revision,
        isCurrent: current,
        staleMessage: 'The symbol changed before it could be opened. Search again.',
        changedMessage: 'The open symbol file changed on disk. Reopen it, then search again.',
      });
    } catch (error) {
      if (current()) report(error);
    }
  }

  function render(result, id) {
    items = result.items;
    list.replaceChildren(...items.map((item, index) => {
      const option = document.createElement('li');
      option.id = 'symbol-option-' + index;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      const name = document.createElement('span');
      name.className = 'symbol-option-name';
      name.textContent = item.container ? item.container + '.' + item.name : item.name;
      const kind = document.createElement('span');
      kind.className = 'symbol-option-kind';
      kind.textContent = item.kind;
      const location = document.createElement('span');
      location.className = 'symbol-option-location';
      location.textContent = `${item.path}:${item.line}:${item.column}`;
      option.append(name, kind, location);
      option.onclick = () => { if (id === generation) void openSymbol(item); };
      return option;
    }));
    const count = items.length;
    const details = [count ? `${result.more ? 'First ' : ''}${count} ${count === 1 ? 'symbol' : 'symbols'}` : 'No matching declarations.'];
    if (result.limited) details.push('Workspace scan limit reached');
    if (result.skipped) details.push(`${result.skipped} unreadable ${result.skipped === 1 ? 'entry' : 'entries'}`);
    status.textContent = details.join(' · ');
    if (count) {
      input.setAttribute('aria-expanded', 'true');
      select(0);
    }
  }

  function refresh() {
    const project = getProject();
    const id = reset();
    const query = input.value.trim();
    if (!project || !query) {
      status.textContent = 'Type the name of a JavaScript or TypeScript declaration.';
      return;
    }
    status.textContent = 'Searching workspace symbols…';
    timer = setTimeout(async () => {
      running = { projectId: project.id, id };
      try {
        const result = await api.symbols(project.id, query, semantic.draftSnapshots(), id);
        if (id === generation) render(result, id);
      } catch (error) {
        if (id === generation) status.textContent = errorText(error);
      } finally {
        if (id === generation) running = undefined;
      }
    }, 120);
  }

  input.addEventListener('input', refresh);
  input.addEventListener('keydown', event => {
    if (!items.length || event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      select((selected + step + items.length) % items.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void openSymbol(items[selected]);
    }
  });
  byId('symbol-cancel').onclick = close;
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });

  return {
    open() {
      if (!getProject() || !semantic.available() || dialog.open) return;
      input.value = '';
      dialog.showModal();
      refresh();
      input.focus();
    },
    close,
    changed() {
      if (dialog.open) refresh();
      else generation++;
    },
  };
}
