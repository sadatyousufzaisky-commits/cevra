const { createHash } = require('node:crypto');
const path = require('node:path');
const { readSource, workspacePath } = require('../workspace.cjs');
const { isTaskId, orderTasks, taskLimit } = require('./task-plan.cjs');

const graphFile = '.cevra-tasks.json';

async function readManifest(workspace, name) {
  const source = await readSource(workspace, name).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!source) return null;
  let data;
  try { data = JSON.parse(source.text.replace(/^\uFEFF/, '')); }
  catch { throw new Error(name + ' is not valid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(name + ' must contain a JSON object.');
  return { data, revision: source.revision };
}

function readTasks(graph, scripts) {
  if (graph.schemaVersion !== 1 || !Array.isArray(graph.tasks) || graph.tasks.length > taskLimit ||
      Object.keys(graph).some(key => !['schemaVersion', 'tasks', 'outputs'].includes(key))) {
    throw new Error('Use a version 1 task graph with up to 128 tasks.');
  }
  const ids = new Set();
  const profiles = new Set(scripts.map(script => script.id));
  const tasks = graph.tasks.map(task => {
    if (!task || !isTaskId(task.id) || ids.has(task.id) || !isTaskId(task.profile) ||
        !Array.isArray(task.after) || task.after.length > taskLimit || !task.after.every(isTaskId) ||
        new Set(task.after).size !== task.after.length ||
        (task.continueOnFailure !== undefined && typeof task.continueOnFailure !== 'boolean') ||
        Object.keys(task).some(key => !['id', 'profile', 'after', 'continueOnFailure'].includes(key))) {
      throw new Error('Each task needs a unique ID, a script profile, and a valid dependency list.');
    }
    if (!profiles.has(task.profile)) throw new Error('Task ' + task.id + ' references unavailable script ' + task.profile + '.');
    ids.add(task.id);
    return { id: task.id, profile: task.profile, after: task.after, continueOnFailure: task.continueOnFailure === true };
  });
  orderTasks(tasks, ids);
  return tasks;
}

function readOutputs(workspace, value = []) {
  if (!Array.isArray(value) || value.length > 16) throw new Error('List up to 16 relative task output folders.');
  return [...new Set(value.map(output => {
    if (typeof output !== 'string' || !output.length || output.length > 240 ||
        output.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
      throw new Error('Task outputs must be relative folder paths.');
    }
    const relative = output.split(/[\\/]/).join(path.sep);
    return path.relative(workspace.root, workspacePath(workspace, relative));
  }))];
}

async function readTaskCatalog(workspace) {
  const [manifest, graph] = await Promise.all([readManifest(workspace, 'package.json'), readManifest(workspace, graphFile)]);
  const entries = manifest?.data.scripts ?? {};
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('package.json scripts must be a JSON object.');
  const scripts = [];
  let omitted = 0;
  for (const [id, command] of Object.entries(entries)) {
    if (!isTaskId(id) || typeof command !== 'string' || !command.trim() || command.includes('\0') || command.length > 4096) {
      omitted++;
      continue;
    }
    if (scripts.length >= taskLimit) throw new Error('Task Weave supports up to 128 package scripts.');
    scripts.push({ id, command });
  }
  const tasks = graph ? readTasks(graph.data, scripts) : [];
  const outputs = graph ? readOutputs(workspace, graph.data.outputs) : [];
  const revision = createHash('sha256').update(JSON.stringify([manifest?.revision, graph?.revision])).digest('hex');
  return { scripts, tasks, outputs, revision, omitted };
}

module.exports = { readTaskCatalog };
