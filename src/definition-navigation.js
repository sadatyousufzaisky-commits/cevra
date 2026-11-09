export function createDefinitionNavigation({ semantic, getActive, getFileRequest, jump, notify, report }) {
  const dialog = document.getElementById('definition-dialog');
  const list = document.getElementById('definition-choices');
  const summary = document.getElementById('definition-summary');
  let sequence = 0;
  let resolveChoice;

  function finish(choice) {
    const resolve = resolveChoice;
    resolveChoice = undefined;
    if (dialog.open) dialog.close();
    list.replaceChildren();
    resolve?.(choice);
  }

  document.getElementById('definition-cancel').onclick = () => finish();
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    finish();
  });

  function choose({ destinations, limited }) {
    const rows = destinations.map(destination => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      const name = document.createElement('span');
      const location = document.createElement('span');
      button.className = 'definition-choice';
      name.textContent = destination.name;
      location.className = 'definition-location';
      location.textContent = `${destination.path}:${destination.line}:${destination.column}`;
      button.append(name, location);
      button.onclick = () => finish(destination);
      row.append(button);
      return row;
    });
    list.replaceChildren(...rows);
    summary.textContent = limited ? `Showing the first ${rows.length} definitions.` :
      `${rows.length} definitions found. Choose a declaration.`;
    return new Promise(resolve => {
      resolveChoice = resolve;
      dialog.showModal();
      list.querySelector('button').focus();
    });
  }

  async function go(view) {
    const tab = getActive();
    if (!tab || !semantic.available() || !view.hasFocus || dialog.open) return;
    if (!tab.language) {
      notify('Go to Definition supports JavaScript and TypeScript files.');
      return;
    }
    const id = ++sequence;
    const fileRequest = getFileRequest();
    const selection = view.state.selection;
    let request;
    const current = () => id === sequence && view.state.selection.eq(selection) &&
      (request ? request.current() : semantic.available() && getActive() === tab);
    const canNavigate = () => current() && fileRequest === getFileRequest();
    try {
      request = semantic.query('definition', tab, selection.main.head);
      const result = await request.result;
      if (!canNavigate() || !view.hasFocus) return;
      const { destinations } = result;
      if (!destinations.length) {
        notify('No workspace definition found at the cursor.');
        return;
      }
      const destination = destinations.length === 1 ? destinations[0] : await choose(result);
      if (!destination || !canNavigate()) return;
      const position = selection.main.head;
      if (destination.documentId === tab.id && destination.offset <= position &&
          position <= destination.offset + destination.length) {
        notify('The cursor is already at the definition.');
        return;
      }
      view.focus();
      await jump(destination, {
        documentId: destination.documentId, version: destination.version, revision: destination.revision,
        isCurrent: () => current() && view.hasFocus,
        staleMessage: 'The definition changed before it could be opened. Try Go to Definition again.',
        changedMessage: 'The open definition file changed on disk. Reopen it, then try Go to Definition again.',
      });
    } catch (error) {
      if (current() && view.hasFocus) report(error);
    }
  }

  return {
    go,
    invalidate() {
      sequence++;
      if (dialog.open) finish();
    },
  };
}
