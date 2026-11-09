const { parentPort } = require('node:worker_threads');
const { createSymbolSearch } = require('./symbol-search.cjs');

let workspaceId;
let index;

parentPort.on('message', ({ id, workspace, query, sources }) => {
  try {
    if (workspaceId !== workspace.id) {
      index?.dispose();
      index = createSymbolSearch(workspace);
      workspaceId = workspace.id;
    }
    parentPort.postMessage({ id, result: index.search(query, sources) });
  } catch (error) {
    index?.dispose();
    index = undefined;
    workspaceId = undefined;
    parentPort.postMessage({ id, error: 'Could not search symbols. ' + error.message.split(/\r?\n/, 1)[0].slice(0, 200) });
  }
});
