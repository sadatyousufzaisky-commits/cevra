const taskId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const taskLimit = 128;

function isTaskId(value) {
  return typeof value === 'string' && taskId.test(value);
}

function orderTasks(tasks, selected) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('Circular task dependency at ' + id + '.');
    const task = byId.get(id);
    if (!task) throw new Error('Missing task dependency ' + id + '.');
    visiting.add(id);
    for (const dependency of task.after) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(task);
  }
  for (const id of selected) visit(id);
  return ordered;
}

function planTask(catalog, target) {
  if (typeof target !== 'string' || !isTaskId(target.slice(4))) throw new Error('Choose a task from the current catalog.');
  const id = target.slice(4);
  if (target.startsWith('npm:') && catalog.scripts.some(script => script.id === id)) {
    return [{ id, profile: id, after: [], continueOnFailure: false }];
  }
  if (target.startsWith('dag:') && catalog.tasks.some(task => task.id === id)) return orderTasks(catalog.tasks, [id]);
  throw new Error('Choose a task from the current catalog.');
}

module.exports = { isTaskId, orderTasks, planTask, taskLimit };
