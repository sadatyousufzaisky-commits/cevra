const fs = require('node:fs/promises');
const path = require('node:path');
const { writeAtomic } = require('./atomic-file.cjs');
const { responsePreferences } = require('./intelligence/response-preferences.cjs');
const { profile: modelProfile } = require('./intelligence/model-profiles.cjs');
const { workbenchLayout } = require('./workbench-layout.cjs');

const themes = new Set(['dark', 'light', 'system', 'midnight']);
const defaultTheme = 'dark';
const editorDefaults = Object.freeze({
  fontSize: 14, fontFamily: 'default', indentWidth: 2, indentStyle: 'spaces',
  wrap: false, lineNumbers: true, cursor: 'thin', formatOnSave: false,
  renameShortcut: 'f2',
});
const editorValidators = {
  fontSize: value => Number.isInteger(value) && value >= 10 && value <= 32,
  fontFamily: value => ['default', 'consolas', 'courier'].includes(value),
  indentWidth: value => Number.isInteger(value) && value >= 1 && value <= 8,
  indentStyle: value => ['spaces', 'tabs'].includes(value),
  wrap: value => typeof value === 'boolean',
  lineNumbers: value => typeof value === 'boolean',
  cursor: value => ['thin', 'wide'].includes(value),
  formatOnSave: value => typeof value === 'boolean',
  renameShortcut: value => ['f2', 'ctrl-alt-r'].includes(value),
};

function editorValues(values, strict = false) {
  const entries = [];
  for (const [name, value] of Object.entries(values ?? {})) {
    if (Object.hasOwn(editorValidators, name) && editorValidators[name](value)) entries.push([name, value]);
    else if (strict) throw new Error('An editor preference is invalid.');
  }
  return Object.fromEntries(entries);
}

function editorSettings(data, root) {
  const global = { ...editorDefaults, ...editorValues(data.editor) };
  const overrides = editorValues(root ? data.workspaces?.[root] : undefined);
  return { global, overrides, effective: { ...global, ...overrides } };
}

function workspaceKey(workspace) {
  return process.platform === 'win32' ? workspace.root.toLowerCase() : workspace.root;
}

function directoryIdentity(workspace) {
  const { dev, ino, birthtimeNs } = workspace.identity;
  return [dev, ino, birthtimeNs].join(':');
}

function recentProjects(data) {
  if (!Array.isArray(data.recentProjects)) return [];
  return data.recentProjects.filter(entry => entry && typeof entry.root === 'string' && path.isAbsolute(entry.root) &&
    typeof entry.name === 'string' && /^[a-f0-9-]{36}$/i.test(entry.id) && typeof entry.identity === 'string').slice(0, 12);
}

function createPreferences(directory) {
  const file = path.join(directory, 'preferences.json');
  let loaded;
  let writes = Promise.resolve();

  async function read() {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch {}
    return {};
  }

  async function current() {
    await writes;
    return loaded ??= read();
  }

  function save(update) {
    const operation = writes.then(async () => {
      const data = await (loaded ??= read());
      const next = update(data);
      if (next === data) return data;
      await fs.mkdir(directory, { recursive: true });
      await writeAtomic(file, JSON.stringify(next, null, 2) + '\n');
      loaded = Promise.resolve(next);
      return next;
    });
    writes = operation.catch(() => {});
    return operation;
  }

  return {
    async rememberExtensionCatalog(generation, digest) {
      await save(data => {
        const prior = data.extensionCatalog;
        if (Number.isSafeInteger(prior?.generation) && prior.generation > generation) throw new Error('The online catalog is older than the last accepted version.');
        if (prior?.generation === generation) {
          if (prior.digest !== digest) throw new Error('The online catalog changed without a new version.');
          return data;
        }
        return { ...data, extensionCatalog: { generation, digest } };
      });
    },
    async getWorkbenchLayout() { return workbenchLayout((await current()).workbenchLayout); },
    async setWorkbenchLayout(value) { await save(data => ({ ...data, workbenchLayout: workbenchLayout(value) })); },
    async recentWorkspaces() {
      return recentProjects(await current()).map(({ id, root, name }) => ({ id, root, name }));
    },
    async recentWorkspace(id) { return recentProjects(await current()).find(entry => entry.id === id); },
    async rememberWorkspace(workspace) {
      const { id, root, name } = workspace;
      const entry = { id, root, name, identity: directoryIdentity(workspace) };
      const key = workspaceKey(workspace);
      await save(data => ({ ...data, recentProjects: [entry, ...recentProjects(data).filter(item => workspaceKey(item) !== key)].slice(0, 12) }));
    },
    matchesRecent(workspace, recent) { return workspaceKey(workspace) === workspaceKey(recent) && directoryIdentity(workspace) === recent.identity; },
    async getTheme() {
      const { theme } = await current();
      return themes.has(theme) ? theme : defaultTheme;
    },
    async setTheme(theme) {
      if (!themes.has(theme)) throw new Error('Choose Dark, Light, System, or Midnight Atelier.');
      await save(data => {
        const next = { ...data, theme };
        delete next.extensionPalette;
        return next;
      });
      return theme;
    },
    async getExtensionPalette() {
      const { extensionPalette } = await current();
      return typeof extensionPalette === 'string' && extensionPalette.length <= 226 ? extensionPalette : null;
    },
    async setExtensionPalette(extensionPalette) {
      await save(data => ({ ...data, extensionPalette }));
    },
    async getIntelligence() {
      return responsePreferences((await current()).intelligence);
    },
    async setIntelligence(values) {
      const intelligence = responsePreferences(values, true);
      await save(data => ({ ...data, intelligence }));
      return intelligence;
    },
    async getIntelligenceModels() {
      return modelProfile((await current()).intelligenceModels);
    },
    async setIntelligenceModels(value) {
      const intelligenceModels = modelProfile(value, true);
      await save(data => ({ ...data, intelligenceModels }));
      return intelligenceModels;
    },
    async getEditor(workspace) {
      return editorSettings(await current(), workspace && workspaceKey(workspace));
    },
    async setEditor(workspace, scope, values) {
      const root = workspace && workspaceKey(workspace);
      const reset = values === null;
      if ((!reset && (!values || typeof values !== 'object' || Array.isArray(values))) ||
          (scope !== 'global' && (scope !== 'workspace' || !root)) || (reset && scope !== 'workspace')) {
        throw new Error('Choose a valid preference scope.');
      }
      const changes = editorValues(values, true);
      const data = await save(data => {
        if (scope === 'global') return { ...data, editor: { ...editorValues(data.editor), ...changes } };
        const workspaces = { ...data.workspaces };
        if (reset) delete workspaces[root];
        else workspaces[root] = { ...editorValues(workspaces[root]), ...changes };
        return { ...data, workspaces };
      });
      return editorSettings(data, root);
    },
    async isTrusted(workspace) {
      const { trusted } = await current();
      const record = trusted?.[workspaceKey(workspace)];
      return record?.schemaVersion === 2 && record.identity === directoryIdentity(workspace);
    },
    async setTrusted(workspace, enabled) {
      await save(data => {
        const trusted = { ...data.trusted };
        const root = workspaceKey(workspace);
        if (enabled) trusted[root] = { schemaVersion: 2, identity: directoryIdentity(workspace) };
        else delete trusted[root];
        return { ...data, trusted };
      });
    },
  };
}

module.exports = { createPreferences };
