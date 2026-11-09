const path = require('node:path');
const { sourceLanguage } = require('./source-language.cjs');
const { maxFileBytes, workspacePath } = require('./workspace.cjs');
const { createWorkerService } = require('./worker-service.cjs');

const maxBuffers = 64;
const maxBufferBytes = 16 * 1024 * 1024;

function createSemanticService() {
  const worker = createWorkerService(path.join(__dirname, 'semantic-worker.cjs'), {
    name: 'language service', task: 'symbol request', capacity: 6, heap: 192,
  });
  return {
    async quickInfo(workspace, file, position, buffers) {
      if (!sourceLanguage(file) || !Array.isArray(buffers) || !buffers.length ||
          !Number.isSafeInteger(position) || position < 0) {
        throw new Error('Choose a JavaScript or TypeScript symbol.');
      }
      if (buffers.length > maxBuffers) throw new Error('Too many open source files for this symbol request.');
      const target = workspacePath(workspace, file);
      let bytes = 0;
      let active;
      const sources = buffers.map(buffer => {
        const absolute = workspacePath(workspace, buffer.path);
        if (!sourceLanguage(buffer.path) || typeof buffer.text !== 'string' ||
            !Number.isSafeInteger(buffer.documentId) || buffer.documentId < 1 ||
            !Number.isSafeInteger(buffer.version) || buffer.version < 0) {
          throw new Error('Invalid document snapshot.');
        }
        const size = Buffer.byteLength(buffer.text);
        bytes += size;
        if (size > maxFileBytes || bytes > maxBufferBytes) throw new Error('Open source text exceeds the analysis limit.');
        if (absolute === target && buffer.path === file) active = buffer;
        return { file: absolute, documentId: buffer.documentId, version: buffer.version, text: buffer.text };
      });
      if (!active || position > active.text.length) throw new Error('The symbol request is outside the current document.');
      return worker.request({
        workspace: { id: workspace.id, root: workspace.root,
          identity: { dev: workspace.identity.dev, ino: workspace.identity.ino } },
        target, position, sources,
      });
    },
    stop: worker.stop,
  };
}

module.exports = { createSemanticService };
