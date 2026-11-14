const { exactRecord } = require('./provider-contract.cjs');

const tasks = Object.freeze(['chat', 'explain', 'patch', 'coding']);
const providers = new Set(['mock', 'openai', 'ollama']);
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const defaults = Object.freeze(Object.fromEntries(tasks.map(task => [task, null])));

function profile(value, strict = false) {
  if (exactRecord(value, tasks) && tasks.every(task => {
    const route = value[task];
    return route === null || (exactRecord(route, ['providerId', 'modelId']) && providers.has(route.providerId) &&
      typeof route.modelId === 'string' && modelId.test(route.modelId) &&
      (task === 'chat' || task === 'explain' || route.providerId !== 'mock'));
  })) return Object.fromEntries(tasks.map(task => [task, value[task] && { ...value[task] }]));
  if (strict) throw new Error('Choose a valid model for each task.');
  return { ...defaults };
}

function modelRoute(catalogs, providerId, id) {
  const catalog = providerId === undefined ?
    catalogs.filter(item => item.models.some(model => model.id === id)) : catalogs.filter(item => item.providerId === providerId);
  if (catalog.length !== 1) return null;
  const model = catalog[0].models.find(item => item.id === id);
  return model ? { catalog: catalog[0], model } : null;
}

module.exports = { profile, modelRoute };
