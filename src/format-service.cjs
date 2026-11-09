const path = require('node:path');
const { sourceLanguage } = require('./source-language.cjs');
const { maxFileBytes, workspacePath } = require('./workspace.cjs');
const { createWorkerService } = require('./worker-service.cjs');

function createFormatService() {
  const worker = createWorkerService(path.join(__dirname, 'format-worker.cjs'), {
    name: 'formatter', task: 'format request', capacity: 4, heap: 192,
  });
  return {
    async format(workspace, file, text, eol, bom = false) {
      const target = workspacePath(workspace, file);
      const language = sourceLanguage(file);
      if (!language || target === workspace.root || typeof text !== 'string' || typeof bom !== 'boolean' ||
          !['\n', '\r\n', '\r'].includes(eol)) {
        throw new Error('Choose a JavaScript or TypeScript document.');
      }
      if (Buffer.byteLength(text) > maxFileBytes) throw new Error('Formatting supports files up to 2 MB.');
      return worker.request({
        workspace: { root: workspace.root, identity: { dev: workspace.identity.dev, ino: workspace.identity.ino } },
        file, text, eol, bom, extension: language.extension,
      });
    },
    stop: worker.stop,
  };
}

module.exports = { createFormatService };
