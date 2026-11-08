const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { maxFileBytes } = require('./workspace.cjs');
const { sourceLanguage } = require('./source-language.cjs');

function createSyntaxService(workerFile = path.join(__dirname, 'syntax-worker.cjs')) {
  const pending = new Map();
  let worker;
  let sequence = 0;

  function retire(thread, message) {
    if (!thread || worker !== thread) return;
    worker = undefined;
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error(message));
    }
    pending.clear();
    void thread.terminate().catch(() => {});
  }

  function getWorker() {
    if (worker) return worker;
    const thread = new Worker(workerFile, { resourceLimits: { maxOldGenerationSizeMb: 128 } });
    worker = thread;
    thread.on('message', ({ id, result, error }) => {
      if (worker !== thread) return;
      const job = pending.get(id);
      if (!job) return;
      clearTimeout(job.timer);
      pending.delete(id);
      if (error) job.reject(new Error(error));
      else job.resolve(result);
    });
    thread.on('error', () => retire(thread, 'The syntax analyzer stopped.'));
    thread.on('exit', () => retire(thread, 'The syntax analyzer stopped.'));
    return thread;
  }

  async function analyze(file, text) {
    const language = sourceLanguage(file);
    if (!language || typeof text !== 'string') throw new Error('Choose a JavaScript or TypeScript document.');
    if (Buffer.byteLength(text) > maxFileBytes) throw new Error('Syntax checking supports files up to 2 MB.');
    if (pending.size >= 48) throw new Error('The syntax analyzer is busy.');
    const thread = getWorker();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => retire(thread, 'The syntax check timed out.'), 10_000);
      pending.set(id, { resolve, reject, timer });
      try {
        thread.postMessage({ id, extension: language.extension, text });
      } catch {
        retire(thread, 'The syntax analyzer stopped.');
      }
    });
  }

  return { analyze, stop: () => retire(worker, 'The syntax check was canceled.') };
}

module.exports = { createSyntaxService };
