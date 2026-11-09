const { parentPort } = require('node:worker_threads');
const { createSemanticProject } = require('./semantic-project.cjs');

let project;
let projectId;

parentPort.on('message', ({ id, workspace, target, position, sources }) => {
  try {
    if (projectId !== workspace.id) {
      project?.dispose();
      project = createSemanticProject(workspace);
      projectId = workspace.id;
    }
    parentPort.postMessage({ id, result: project.quickInfo(target, position, sources) });
  } catch (error) {
    project?.dispose();
    project = undefined;
    projectId = undefined;
    parentPort.postMessage({ id, error: 'Could not inspect this symbol. ' + error.message.split(/\r?\n/, 1)[0].slice(0, 200) });
  }
});
