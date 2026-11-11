export function createEditPreview({ prepare, stage, errorText }) {
  const byId = id => document.getElementById(id);
  const dialog = byId('edits-dialog');
  const heading = byId('edits-heading');
  const form = byId('rename-form');
  const name = byId('rename-name');
  const status = byId('edits-status');
  const preview = byId('edits-preview');
  const cancel = byId('edits-cancel');
  const apply = byId('edits-apply');
  let generation = 0;
  let applying = false;
  let prepared;

  function clear() {
    prepared = undefined;
    apply.disabled = true;
    preview.replaceChildren();
    return ++generation;
  }

  function render(changes) {
    const groups = document.createDocumentFragment();
    for (const { path, doc, edits, tab } of changes) {
      const group = document.createElement('details');
      group.open = true;
      const title = document.createElement('summary');
      title.textContent = path + ' · ' + edits.length + (edits.length === 1 ? ' edit' : ' edits') +
        (tab?.dirty ? ' · unsaved buffer' : '');
      group.append(title);
      for (const edit of edits) {
        const line = doc.lineAt(edit.from);
        const label = document.createElement('div');
        label.className = 'edit-location';
        label.textContent = 'Line ' + line.number + ', column ' + (edit.from - line.from + 1);
        const from = Math.max(line.from, edit.from - 30);
        const to = Math.min(line.to, edit.to + 30);
        const prefix = (from > line.from ? '…' : '') + doc.sliceString(from, edit.from);
        const suffix = doc.sliceString(edit.to, to) + (to < line.to ? '…' : '');
        for (const [kind, value] of [['Before', doc.sliceString(edit.from, edit.to)], ['After', edit.insert]]) {
          const row = document.createElement('pre');
          row.dataset.edit = kind;
          row.append(kind + '  ' + prefix);
          const changed = document.createElement(kind === 'Before' ? 'del' : 'ins');
          changed.textContent = value;
          row.append(changed, suffix);
          label.append(row);
        }
        group.append(label);
      }
      groups.append(group);
    }
    preview.replaceChildren(groups);
  }

  async function load(getFiles, replacement, recheck = false) {
    const request = clear();
    status.textContent = 'Preparing preview…';
    try {
      const files = await getFiles();
      if (request !== generation || !dialog.open) return;
      const result = await prepare(files, replacement);
      if (request !== generation || !dialog.open) return;
      if (!result.changes.length) throw new Error('There are no changes to apply.');
      prepared = { result, verify: recheck ? async () => {
        if (JSON.stringify(files) !== JSON.stringify(await getFiles())) {
          throw new Error('The rename scope changed. Refresh the preview.');
        }
      } : undefined };
      render(result.changes);
      const count = result.changes.reduce((total, file) => total + file.edits.length, 0);
      status.textContent = count + (count === 1 ? ' edit' : ' edits') + ' in ' + result.changes.length +
        (result.changes.length === 1 ? ' file. ' : ' files. ') + 'Apply creates recoverable drafts. Save to update the originals.';
      if (result.skipped) status.textContent += ' Search skipped ' + result.skipped + ' unreadable or unsupported entries.';
      apply.disabled = false;
    } catch (error) {
      if (request === generation && dialog.open) status.textContent = errorText(error);
    }
  }

  cancel.onclick = () => dialog.close();
  dialog.oncancel = event => { if (applying) event.preventDefault(); };
  dialog.onclose = () => { if (!dialog.open) clear(); };
  name.oninput = () => {
    clear();
    status.textContent = 'Preview the new identifier before applying.';
  };
  apply.onclick = async () => {
    if (!prepared || applying) return;
    applying = apply.disabled = cancel.disabled = form.inert = true;
    try {
      await stage(prepared.result, prepared.verify);
      dialog.close();
    } catch (error) {
      clear();
      status.textContent = errorText(error);
    } finally {
      applying = cancel.disabled = form.inert = false;
    }
  };

  return {
    replace(result, replacement) {
      heading.textContent = 'Replace in Project';
      form.hidden = true;
      dialog.showModal();
      void load(() => result, replacement);
    },
    rename(getFiles) {
      clear();
      heading.textContent = 'Rename Symbol';
      form.hidden = false;
      name.value = '';
      status.textContent = 'Enter a new identifier to preview its edits.';
      form.onsubmit = event => {
        event.preventDefault();
        const nextName = name.value;
        void load(async () => ({ files: await getFiles(nextName) }), undefined, true);
      };
      dialog.showModal();
      name.focus();
    },
    extension(getFiles) {
      heading.textContent = 'Review Extension Edit';
      form.hidden = true;
      dialog.showModal();
      void load(getFiles, undefined, true);
    },
  };
}
