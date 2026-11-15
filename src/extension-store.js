import { comparePackageVersions } from './extensions/manifest.cjs';

export function createExtensionStore({ api, review, errorText }) {
  const panel = document.getElementById('extension-store');
  const search = document.getElementById('extension-store-search');
  const category = document.getElementById('extension-store-category');
  const source = document.getElementById('extension-store-source');
  const heading = document.getElementById('extension-store-heading');
  const hint = document.getElementById('extension-store-source-note');
  const refresh = document.getElementById('extension-store-refresh');
  const status = document.getElementById('extension-store-status');
  const list = document.getElementById('extension-store-list');
  let packages;
  let installed = new Map();
  let installedError;
  let loading = false;
  let busy = false;
  let generation = 0;

  function focus(id) {
    const rows = [...list.querySelectorAll('button:not(:disabled)')];
    (rows.find(button => button.dataset.releaseId === id) ?? search).focus();
  }

  function card(release) {
    const row = document.createElement('li');
    row.className = 'extension-store-card';
    const title = document.createElement('h4');
    title.textContent = release.displayName;
    title.id = 'extension-release-' + release.id;
    row.setAttribute('aria-labelledby', title.id);
    const identity = document.createElement('p');
    identity.className = 'extension-release-identity';
    identity.textContent = [release.publisher, release.version, release.category].join(' · ');
    const description = document.createElement('p');
    description.textContent = release.description;
    const detail = document.createElement('p');
    detail.className = 'extension-release-detail';
    detail.textContent = release.unavailable ?? (release.executable ? (!packages.hostSupported ?
      'Executable activation is unavailable on this system.' :
      'Isolated Wasm · Permission review for each session') : 'Declarative · No runtime permissions');
    if (release.unavailable) detail.dataset.unavailable = 'true';
    const controls = document.createElement('div');
    controls.className = 'extension-release-actions';
    const current = installed.get(release.id);
    const same = current?.sha256 === release.sha256;
    const comparison = current ? comparePackageVersions(release.version, current.version) : 0;
    const state = document.createElement('span');
    state.className = 'extension-release-state';
    state.textContent = installedError ? 'Installed status unavailable' : !current ? '' : same ?
      'Installed' : current.pinned ? 'Version ' + current.version + ' pinned' : comparison > 0 ?
        'Update available' : comparison < 0 ? 'Installed version is newer' : 'Installed release has different bytes';
    state.hidden = !state.textContent;
    controls.append(state);
    if (!release.unavailable) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button' + (same || current?.pinned ? '' : ' primary');
      button.dataset.releaseId = release.id;
      const online = source.value === 'online';
      button.textContent = online ? comparison > 0 && !current?.pinned ? 'Download & Review Update' : 'Download & Review' :
        same || current?.pinned ? 'View Details' : comparison > 0 ? 'Review Update' :
          comparison < 0 ? 'Review Older Version' : 'Review Package';
      button.setAttribute('aria-describedby', title.id);
      button.disabled = busy || loading || Boolean(installedError);
      button.onclick = () => review(release, button, source.value);
      controls.append(button);
    }
    row.append(title, identity, description, detail, controls);
    return row;
  }

  function render() {
    if (panel.hidden) return;
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.releaseId : undefined;
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const entries = (packages?.entries ?? []).filter(entry => {
      const matching = [entry.displayName, entry.id, entry.publisher, entry.description, entry.category].join(' ').toLowerCase();
      return (!category.value || category.value === entry.category) && terms.every(term => matching.includes(term));
    });
    const message = loading ? (source.value === 'online' ? 'Verifying the online catalog…' : 'Checking bundled packages…') : packages?.error ?? (installedError ?
      'Installed extension information is unavailable. You can still browse the catalog.' :
      entries.length ? entries.length === 1 ? '1 package' : entries.length + ' packages' :
        search.value.trim() || category.value ? 'No packages match these filters.' : 'This catalog has no packages.');
    if (status.textContent !== message) status.textContent = message;
    refresh.disabled = loading || busy;
    list.replaceChildren(...entries.map(card));
    if (focused) focus(focused);
  }

  async function load() {
    const request = ++generation;
    const online = source.value === 'online';
    heading.textContent = online ? 'Online catalog' : 'Bundled catalog';
    hint.textContent = online ? 'Download an extension over HTTPS, then review the package before installation.' :
      'These packages are included with VOKRI Code and available offline.';
    loading = true;
    packages = undefined;
    render();
    try {
      const result = await api.extensionStore(source.value);
      if (request === generation) packages = result;
    } catch (error) {
      if (request === generation) packages = { entries: [], error: errorText(error) };
    } finally {
      if (request === generation) {
        loading = false;
        render();
      }
    }
  }

  search.oninput = category.onchange = render;
  source.onchange = refresh.onclick = () => void load();

  return {
    focus,
    load,
    show(visible) { panel.hidden = !visible; if (visible) render(); },
    setBusy(value) {
      busy = value;
      refresh.disabled = loading || busy;
      for (const button of list.querySelectorAll('button')) button.disabled = value || loading || Boolean(installedError);
    },
    update(snapshot) {
      installed = new Map(snapshot.catalog.map(entry => [entry.id, entry]));
      installedError = snapshot.catalogError;
      render();
    },
  };
}
