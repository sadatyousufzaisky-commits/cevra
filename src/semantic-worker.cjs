const { parentPort } = require('node:worker_threads');
const { createSemanticProject } = require('./semantic-project.cjs');

const errors = {
  quickInfo: 'Could not inspect this symbol. ',
  complete: 'Could not suggest completions. ',
  signatureHelp: 'Could not show the function signature. ',
  definition: 'Could not find the definition. ',
  references: 'Could not find references. ',
  rename: 'Could not preview this rename. ',
  diagnostics: 'Could not check types. ',
};

let project;
let projectId;

parentPort.on('message', ({ id, workspace, operation, target, position, sources, argument }) => {
  try {
    if (projectId !== workspace.id) {
      project?.dispose();
      project = createSemanticProject(workspace);
      projectId = workspace.id;
    }
    parentPort.postMessage({ id, result: project[operation](target, position, sources, argument) });
  } catch (error) {
    project?.dispose();
    project = undefined;
    projectId = undefined;
    const message = errors[operation] ?? 'Could not analyze this source position. ';
    parentPort.postMessage({ id, error: message + error.message.split(/\r?\n/, 1)[0].slice(0, 200) });
  }
});
