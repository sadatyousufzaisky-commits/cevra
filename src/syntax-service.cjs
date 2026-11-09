const path = require('node:path');
const { maxFileBytes } = require('./workspace.cjs');
const { sourceLanguage } = require('./source-language.cjs');
const { createWorkerService } = require('./worker-service.cjs');

function createSyntaxService(workerFile = path.join(__dirname, 'syntax-worker.cjs')) {
  const worker = createWorkerService(workerFile, { name: 'syntax analyzer', task: 'syntax check', capacity: 48 });
  return {
    async analyze(file, text) {
      const language = sourceLanguage(file);
      if (!language || typeof text !== 'string') throw new Error('Choose a JavaScript or TypeScript document.');
      if (Buffer.byteLength(text) > maxFileBytes) throw new Error('Syntax checking supports files up to 2 MB.');
      return worker.request({ extension: language.extension, text });
    },
    stop: worker.stop,
  };
}

module.exports = { createSyntaxService };
