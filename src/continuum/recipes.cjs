const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readSource, resolveEntry, saveSource, workspacePath } = require('../workspace.cjs');
const { runtimeKind, typeScriptProfile } = require('../runtime-kind.cjs');
const { readTaskCatalog } = require('./task-catalog.cjs');
const { isTaskId, planTask } = require('./task-plan.cjs');

const recipeFile = '.cevra-recipes.json';
const maxRecipeBytes = 128 * 1024;
const pythonProfiles = { '.venv': 'Workspace .venv', venv: 'Workspace venv', path: 'On PATH' };
const changedRecipe = 'The recipe or one of its references changed. Refresh Recipes and review the plan again.';

function object(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}

function singleLine(value, limit) {
  return typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(value);
}

function stepFor(workspace, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Each recipe step must be an object.');
  if (value.kind === 'test' && object(value, ['kind', 'goal']) && (value.goal === undefined || singleLine(value.goal, 120))) {
    const goal = value.goal?.trim();
    return goal ? { kind: 'test', goal } : { kind: 'test' };
  }
  if (value.kind === 'task' && object(value, ['kind', 'target']) && typeof value.target === 'string' &&
      /^(?:npm|dag):/.test(value.target) && isTaskId(value.target.slice(4))) return { kind: 'task', target: value.target };
  if (['run', 'debug'].includes(value.kind) && object(value, ['kind', 'file', 'profile']) && singleLine(value.file, 512)) {
    const pieces = value.file.split(/[\\/]/);
    if (pieces.some(part => !part || part === '.' || part === '..')) throw new Error('Recipe files must use relative workspace paths.');
    const file = path.relative(workspace.root, workspacePath(workspace, pieces.join(path.sep))).split(path.sep).join('/');
    const language = runtimeKind(file);
    const validProfile = language === 'python' ? typeof value.profile === 'string' && Object.hasOwn(pythonProfiles, value.profile) : value.profile === undefined;
    if (!language || !validProfile || (value.kind === 'debug' && language !== 'javascript')) {
      throw new Error('Choose a supported entry file and runtime. Python recipes require a .venv, venv, or path profile.');
    }
    return { kind: value.kind, file, ...(language === 'python' ? { profile: value.profile } : {}) };
  }
  throw new Error('Use a supported run, debug, test, or Task Weave step.');
}

function parseRecipes(workspace, text) {
  if (Buffer.byteLength(text) > maxRecipeBytes) throw new Error('The recipe file exceeds 128 KiB.');
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('The recipe file is not valid JSON.'); }
  if (!object(data, ['schemaVersion', 'recipes']) || !Array.isArray(data.recipes) || data.recipes.length > 32) {
    throw new Error('Use a recipe file with up to 32 recipes.');
  }
  const { schemaVersion } = data;
  if (![1, 2].includes(schemaVersion)) throw new Error('This recipe schema version is unsupported.');
  const ids = new Set();
  const recipes = data.recipes.map(value => {
    if (!object(value, schemaVersion === 1 ? ['id', 'name', 'kind', 'file', 'profile', 'target', 'goal'] : ['id', 'name', 'steps']) ||
        !isTaskId(value.id) || ids.has(value.id) || !singleLine(value.name, 80) || !value.name.trim()) {
      throw new Error('Each recipe needs a unique ID and a single-line name.');
    }
    ids.add(value.id);
    const { id, name, ...definition } = value;
    const steps = schemaVersion === 1 ? [definition] : definition.steps;
    if (!Array.isArray(steps) || !steps.length || steps.length > 8) throw new Error('Each recipe needs one to eight steps.');
    const normalized = steps.map(step => stepFor(workspace, step));
    if (normalized.length > 1 && normalized.some(step => step.kind === 'debug')) throw new Error('A debug step must be the only step in its recipe.');
    return { id, name: name.trim(), steps: normalized };
  });
  return { schemaVersion, recipes };
}

async function recipeCatalog(workspace) {
  const source = await readSource(workspace, recipeFile).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!source) return { recipes: [], missing: true };
  return { ...parseRecipes(workspace, source.text), revision: source.revision };
}

async function resolveRecipe(workspace, python, id) {
  if (!isTaskId(id)) throw new Error('Choose a recipe from the current workspace.');
  const catalog = await recipeCatalog(workspace);
  const recipe = catalog.recipes.find(item => item.id === id);
  if (!recipe) throw new Error('The selected recipe is unavailable. Refresh Recipes.');
  let tasks;
  let interpreters;
  const steps = [];
  for (const [index, step] of recipe.steps.entries()) {
    let label;
    let details;
    let pin;
    let runtime;
    let revision;
    if (step.kind === 'task') {
      tasks ??= await readTaskCatalog(workspace);
      const plan = planTask(tasks, step.target);
      const scripts = new Map(tasks.scripts.map(script => [script.id, script.command]));
      label = 'Task ' + step.target.slice(4);
      details = plan.map(item => item.id + ' · npm --ignore-scripts run ' + item.profile + '\n' + scripts.get(item.profile) +
        (item.after.length ? '\nAfter ' + item.after.join(', ') +
          (item.continueOnFailure ? ' · Continue if a dependency fails' : '') : ''));
      pin = tasks.revision;
    } else if (step.kind === 'test') {
      label = step.goal ? 'Test · ' + step.goal : 'Project tests';
      details = ['Full JavaScript test suite'];
    } else {
      const source = await readSource(workspace, step.file);
      revision = source.revision;
      const language = runtimeKind(step.file);
      label = (step.kind === 'debug' ? 'Debug ' : 'Run ') + step.file;
      if (language === 'python') {
        interpreters ??= await python.list();
        const selected = interpreters.find(profile => profile.label === pythonProfiles[step.profile]);
        if (!selected) throw new Error('The recipe’s Python interpreter is unavailable for ' + step.file + '.');
        runtime = pin = selected.id;
        details = [selected.file];
      } else {
        runtime = language === 'typescript' ? typeScriptProfile : undefined;
        details = [language === 'typescript' ? 'Bundled Node.js TypeScript profile' : 'Bundled Node.js'];
      }
    }
    steps.push({ ...step, id: `${index + 1}. ${label}`, details, pin, runtime, revision });
  }
  const preview = steps.map(({ id, kind, details }) => ({ id, kind, details }));
  if (Buffer.byteLength(JSON.stringify(preview)) > 64 * 1024) throw new Error('This recipe expands beyond the review limit.');
  const digest = createHash('sha256').update(JSON.stringify([catalog.revision, id, steps.map(step => step.pin)])).digest('hex');
  return { id, name: recipe.name, digest, steps, preview };
}

async function requireRecipe(workspace, python, id, digest) {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Review a recipe before running it.');
  const current = await resolveRecipe(workspace, python, id).catch(() => { throw new Error(changedRecipe); });
  if (current.digest !== digest) throw new Error(changedRecipe);
  return current;
}

function encodeRecipes(recipes) { return JSON.stringify({ schemaVersion: 2, recipes }, null, 2) + '\n'; }

async function createRecipeFile(workspace) {
  const root = await resolveEntry(workspace, '');
  const target = path.join(root, recipeFile);
  const handle = await fs.open(target, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('The recipe file already exists. Refresh Recipes.');
    throw error;
  });
  let identity;
  try {
    identity = await handle.stat({ bigint: true });
    await handle.writeFile(encodeRecipes([{ id: 'project-tests', name: 'Project tests', steps: [{ kind: 'test' }] }]));
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await resolveEntry(workspace, recipeFile).then(async file => {
      const current = await fs.lstat(file, { bigint: true });
      if (identity && current.dev === identity.dev && current.ino === identity.ino && current.birthtimeNs === identity.birthtimeNs) {
        await fs.unlink(target);
      }
    }).catch(() => {});
    throw error;
  }
  await handle.close();
}

async function upgradeRecipes(workspace, revision) {
  const source = await readSource(workspace, recipeFile);
  const catalog = parseRecipes(workspace, source.text);
  if (catalog.schemaVersion !== 1 || source.revision !== revision) throw new Error('The recipe file changed. Refresh before upgrading.');
  const text = source.text.includes('\r\n') ? encodeRecipes(catalog.recipes).replaceAll('\n', '\r\n') : encodeRecipes(catalog.recipes);
  await saveSource(workspace, recipeFile, (source.text.startsWith('\uFEFF') ? '\uFEFF' : '') + text, revision);
}

module.exports = { createRecipeFile, recipeCatalog, recipeFile, requireRecipe, resolveRecipe, upgradeRecipes };
