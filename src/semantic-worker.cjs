const { parentPort } = require('node:worker_threads');
const { createSemanticProject } = require('./semantic-project.cjs');

let project;
let projectId;

parentPort.on('message', ({ id, workspace, operation, target, position, sources }) => {
  try {
    if (projectId !== workspace.id) {
      project?.dispose();
      project = createSemanticProject(workspace);
      projectId = workspace.id;
    }
    const query = operation === 'complete' ? project.complete : project.quickInfo;
    parentPort.postMessage({ id, result: query(target, position, sources) });
  } catch (error) {
    project?.dispose();
    project = undefined;
    projectId = undefined;
    const message = operation === 'complete' ? 'Could not suggest completions. ' : 'Could not inspect this symbol. ';
    parentPort.postMessage({ id, error: message + error.message.split(/\r?\n/, 1)[0].slice(0, 200) });
  }
});
