const { createHash } = require('node:crypto');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { inside, readInputRevision, resolveEntry } = require('../workspace.cjs');

const windows = process.platform === 'win32';
const executableNames = windows ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
const venvBin = windows ? 'Scripts' : 'bin';
const pythonName = windows ? /^python(?:3(?:\.\d+)?t?)?\.exe$/i : /^python(?:3(?:\.\d+)?t?)?$/;
const changedInterpreter = 'The Python interpreter changed or is unavailable. Refresh interpreters and choose it again.';

function pathKey(file) {
  return windows ? file.toLowerCase() : file;
}

function storeAlias(file) {
  return windows && path.normalize(file).split(path.sep).some(part => part.toLowerCase() === 'windowsapps');
}

function createPythonProfiles(workspace, searchPath = process.env.PATH ?? '') {
  let available = new Map();
  let custom;
  let listing = 0;

  async function inspect(file, label, venv) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !pythonName.test(path.basename(file)) || storeAlias(file)) return null;
    try {
      const resolved = await fs.realpath(file);
      if (storeAlias(resolved)) return null;
      const stat = await fs.stat(resolved, { bigint: true });
      if (!stat.isFile()) return null;
      if (!windows) await fs.access(file, constants.X_OK);
      let config;
      if (venv) {
        const folder = await resolveEntry(workspace, path.join(venv, venvBin));
        if (path.relative(folder, path.dirname(file)) !== '') return null;
        config = await readInputRevision(workspace, path.join(venv, 'pyvenv.cfg'));
      }
      const id = createHash('sha256').update(JSON.stringify([pathKey(file), pathKey(resolved),
        [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String), config?.revision, config?.stamp])).digest('hex');
      return { id, file, label, venv, resolved };
    } catch { return null; }
  }

  async function list() {
    const request = ++listing;
    const found = new Map();
    function add(profile) {
      if (profile && !found.has(pathKey(profile.file))) found.set(pathKey(profile.file), profile);
    }
    for (const venv of ['.venv', 'venv']) {
      for (const name of executableNames) {
        const profile = await inspect(path.join(workspace.root, venv, venvBin, name), 'Workspace ' + venv, venv);
        if (profile) { add(profile); break; }
      }
    }
    if (custom) add(await inspect(custom, 'Selected interpreter'));
    const folders = searchPath.split(path.delimiter).map(folder => folder.replace(/^"|"$/g, ''))
      .filter(folder => path.isAbsolute(folder) && !inside(workspace.root, folder)).slice(0, 48);
    for (const folder of new Set(folders)) {
      for (const name of executableNames) {
        const file = path.join(folder, name);
        const profile = await inspect(file, 'On PATH');
        if (profile && !inside(workspace.root, profile.resolved)) {
          add(profile);
          break;
        }
      }
      if (found.size >= 8) break;
    }
    const profiles = [...found.values()];
    if (request === listing) available = new Map(profiles.map(profile => [profile.id, profile]));
    return profiles.map(({ id, file, label }) => ({ id, file, label }));
  }

  return {
    list,
    async choose(file) {
      file = typeof file === 'string' ? path.normalize(file) : file;
      const chosen = await inspect(file, 'Selected interpreter');
      if (!chosen) throw new Error('Choose an installed Python 3 interpreter executable.');
      custom = file;
      const profiles = await list();
      return { profiles, selected: profiles.find(profile => pathKey(profile.file) === pathKey(file))?.id };
    },
    async resolve(id) {
      const expected = available.get(id);
      if (!expected) throw new Error('Choose a Python interpreter for this workspace.');
      const current = await inspect(expected.file, expected.label, expected.venv);
      if (current?.id !== expected.id) throw new Error(changedInterpreter);
      return current;
    },
  };
}

module.exports = { createPythonProfiles };
