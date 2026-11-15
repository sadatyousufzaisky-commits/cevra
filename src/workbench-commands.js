function keyFor(event) {
  const key = event.code === 'Backquote' ? '`' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key]
    .filter(Boolean).join('+');
}

const shortcutFor = command => typeof command.key === 'function' ? command.key() : command.key;

export function createCommandRegistry(definitions, report) {
  const commands = new Map(definitions.map(command => [command.id, command]));
  function available(command) {
    return Boolean(command && (!command.enabled || command.enabled()));
  }

  function run(id) {
    const command = commands.get(id);
    if (!available(command)) return;
    try { Promise.resolve(command.run()).catch(report); }
    catch (error) { report(error); }
  }

  return {
    run,
    bind(element, id) { element.onclick = () => run(id); },
    find(query) {
      const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
      return [...commands.values()].filter(command => available(command) && !command.hidden && terms.every(term =>
        `${command.title} ${shortcutFor(command) ?? ''} ${command.words ?? ''}`.toLowerCase().includes(term)));
    },
    keydown(event) {
      if (event.defaultPrevented || event.isComposing) return;
      const key = keyFor(event);
      const command = [...commands.values()].find(command => {
        return (shortcutFor(command) === key || command.alternate === key) && (!command.context || command.context());
      });
      if (!command) return;
      event.preventDefault();
      if (!event.repeat) run(command.id);
    },
  };
}

export function createCommandCenter({ api, registry, workspace, recent, openFiles, openFile, openRecent, icon, fileIcon, errorText }) {
  const dialog = document.getElementById('command-center');
  const query = document.getElementById('command-query');
  const results = document.getElementById('command-results');
  const status = document.getElementById('command-status');
  const modes = [...dialog.querySelectorAll('[data-mode]')];
  const placeholders = { files: 'Find by file name or path', commands: 'Find a command', projects: 'Find a recent project' };
  let mode;
  let items = [];
  let selected = -1;
  let timer;
  let running;
  let generation = 0;

  function invalidate() {
    clearTimeout(timer);
    if (running) void api.cancelFileSearch(running.project, running.id).catch(() => {});
    running = undefined;
    return ++generation;
  }

  function select(index) {
    results.children[selected]?.setAttribute('aria-selected', 'false');
    selected = index;
    const row = results.children[index];
    if (row) {
      row.setAttribute('aria-selected', 'true');
      query.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    } else query.removeAttribute('aria-activedescendant');
  }

  function close() {
    invalidate();
    if (dialog.open) dialog.close();
  }

  function activate(index) {
    const item = items[index];
    if (!item) return;
    close();
    item.action();
  }

  function render(rows, message) {
    items = rows;
    results.replaceChildren(...rows.map((item, index) => {
      const row = document.createElement('li');
      row.className = 'command-option';
      row.id = 'command-result-' + index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      const text = document.createElement('span');
      text.className = 'command-option-text';
      const title = document.createElement('span');
      title.textContent = item.name;
      text.append(title);
      if (item.detail) {
        const detail = document.createElement('small');
        detail.textContent = item.detail;
        text.append(detail);
      }
      row.append(item.icon(), text);
      if (item.shortcut) {
        const shortcut = document.createElement('kbd');
        shortcut.textContent = item.shortcut;
        row.append(shortcut);
      }
      row.onpointerdown = event => event.preventDefault();
      row.onclick = () => activate(index);
      return row;
    }));
    selected = -1;
    select(rows.length ? 0 : -1);
    query.setAttribute('aria-expanded', String(rows.length > 0));
    status.textContent = message;
  }

  const fileItem = file => ({ name: file.name, detail: file.path, icon: () => fileIcon(file.name), action: () => openFile(file.path) });
  const commandItem = command => ({ name: command.title, detail: command.detail, icon: () => icon(command.icon || 'chevron'),
    shortcut: shortcutFor(command), action: () => registry.run(command.id) });

  function refresh() {
    const id = invalidate();
    const input = query.value.trim();
    const project = workspace();
    if (mode === 'commands') {
      const list = registry.find(input).map(commandItem);
      render(list, list.length ? `${list.length} available ${list.length === 1 ? 'command' : 'commands'}` : 'No available commands match.');
    } else if (mode === 'projects') {
      const term = input.toLowerCase();
      const list = recent().filter(entry => `${entry.name} ${entry.root}`.toLowerCase().includes(term)).map(entry => ({
        name: entry.name, detail: entry.root, icon: () => icon('folder'), action: () => openRecent(entry.id),
      }));
      render(list, list.length ? `${list.length} recent ${list.length === 1 ? 'project' : 'projects'}` : 'No matching recent projects.');
    } else if (!project) {
      render(registry.find('open folder').map(commandItem), 'Open a project to find files.');
    } else if (!input) {
      const list = openFiles().map(fileItem);
      render(list, list.length ? 'Open files · Type to search the whole project.' : 'Type a file name or path.');
    } else {
      render([], 'Finding files…');
      timer = setTimeout(async () => {
        running = { project: project.id, id };
        try {
          const result = await api.findFiles(project.id, id, input);
          if (id !== generation || workspace() !== project || !dialog.open) return;
          const count = result.files.length;
          const details = [count ? `${result.more ? 'Top ' : ''}${count} ${count === 1 ? 'file' : 'files'}` : 'No matching files.'];
          if (result.limited) details.push('Search limit reached');
          if (result.skipped) details.push(`${result.skipped} inaccessible ${result.skipped === 1 ? 'folder' : 'folders'}`);
          render(result.files.map(fileItem), details.join(' · '));
        } catch (error) {
          if (id === generation) render([], errorText(error));
        } finally {
          if (id === generation) running = undefined;
        }
      }, 95);
    }
  }

  function setMode(next, text = '') {
    mode = next;
    for (const button of modes) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    query.value = text;
    query.placeholder = placeholders[mode];
    refresh();
    query.focus();
  }

  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  document.getElementById('close-commands').onclick = close;
  for (const button of modes) button.onclick = () => setMode(button.dataset.mode);
  query.oninput = () => {
    if (query.value.startsWith('>')) setMode('commands', query.value.slice(1));
    else refresh();
  };
  query.onkeydown = event => {
    if (event.isComposing || !items.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      select((selected + step + items.length) % items.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activate(selected);
    }
  };

  return {
    open(next = 'files', query = '') {
      if (document.querySelector('dialog[open]')) return;
      dialog.showModal();
      setMode(next, query);
    },
    close,
  };
}
