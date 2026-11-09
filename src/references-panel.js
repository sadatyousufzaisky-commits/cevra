export function createReferencesPanel({ api, semantic, getActive, show, jump, errorText }) {
  const byId = id => document.getElementById(id);
  const status = byId('references-status');
  const scope = byId('references-scope');
  const list = byId('reference-results');
  const cancel = byId('references-cancel');
  const instructions = 'Place the cursor on a JavaScript or TypeScript symbol and choose Find References.';
  let sequence = 0;
  let running;
  let ready = false;

  function clear(message) {
    sequence++;
    if (running) void api.cancelReferences(running.projectId, running.id).catch(() => {});
    running = undefined;
    ready = false;
    list.replaceChildren();
    cancel.hidden = true;
    status.textContent = message;
    scope.textContent = '';
    return sequence;
  }

  function row(file, match, id) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'problem-row reference-row';
    const location = document.createElement('span');
    location.className = 'problem-location';
    location.textContent = `${match.line}:${match.column}`;
    const preview = document.createElement('code');
    preview.textContent = match.preview;
    button.append(location, preview);
    const name = `${file.path}:${location.textContent} ${match.declaration ? 'Declaration ' : ''}${match.preview}`;
    button.title = name;
    button.setAttribute('aria-label', name);
    if (match.declaration) {
      const kind = document.createElement('span');
      kind.className = 'reference-kind';
      kind.textContent = 'Declaration';
      button.append(kind);
    }
    button.onclick = async () => {
      if (id !== sequence) return;
      try {
        await jump({ ...match, path: file.path }, {
          documentId: file.documentId, version: file.version, revision: file.revision,
          isCurrent: () => id === sequence && semantic.available(),
          staleMessage: 'The reference changed before it could be opened. Run Find References again.',
          changedMessage: 'The open reference file changed on disk. Reopen it, then run Find References again.',
        });
      } catch (error) {
        if (id === sequence) clear(errorText(error));
      }
    };
    item.append(button);
    return item;
  }

  function render(result, id, origin) {
    const { files, count } = result;
    const fragment = document.createDocumentFragment();
    for (const file of files) {
      const group = document.createElement('li');
      const heading = document.createElement('h3');
      heading.className = 'problem-file';
      heading.textContent = file.path;
      const matches = document.createElement('ul');
      matches.append(...file.matches.map(match => row(file, match, id)));
      group.append(heading, matches);
      fragment.append(group);
    }
    list.replaceChildren(fragment);
    const countLabel = result.resultLimited ? `First ${count}` : String(count);
    status.textContent = count ? `${countLabel} ${count === 1 ? 'reference' : 'references'} in ${files.length} ${files.length === 1 ? 'file' : 'files'}` :
      'No references found in the searched files.';
    const details = [result.symbol || origin, result.scope === '.' ? 'Workspace root' : result.scope];
    if (result.scopeLimited) details.push('Search scope limit reached');
    if (result.separateProjects) details.push('Separate project configurations skipped');
    if (result.skipped) details.push(`${result.skipped} unreadable ${result.skipped === 1 ? 'entry' : 'entries'}`);
    scope.textContent = scope.title = details.join(' · ');
  }

  cancel.onclick = () => clear('Reference search canceled.');
  status.textContent = instructions;

  return {
    async find(view) {
      if (!semantic.available()) return;
      const tab = getActive();
      show();
      const id = clear(instructions);
      if (!tab?.language) return;
      const position = view.state.selection.main.head;
      const line = view.state.doc.lineAt(position);
      const origin = `${tab.path}:${line.number}:${position - line.from + 1}`;
      status.textContent = `Finding references from ${origin}…`;
      running = { id, projectId: tab.projectId };
      cancel.hidden = false;
      try {
        const result = await semantic.query('references', tab, position, id).result;
        if (id !== sequence) return;
        ready = true;
        render(result, id, origin);
      } catch (error) {
        if (id === sequence) status.textContent = errorText(error);
      } finally {
        if (id === sequence) {
          running = undefined;
          cancel.hidden = true;
        }
      }
    },
    changed() {
      if (running || ready) clear('Source changed. Run Find References again.');
    },
    reset() { clear(instructions); },
  };
}
