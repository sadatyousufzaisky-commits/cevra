const { Worker } = require('node:worker_threads');

function createWorkerService(workerFile, { name, task, capacity, heap = 128 }) {
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
    const thread = new Worker(workerFile, { resourceLimits: { maxOldGenerationSizeMb: heap } });
    const stopped = () => retire(thread, 'The ' + name + ' stopped.');
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
    thread.on('error', stopped);
    thread.on('exit', stopped);
    return thread;
  }

  async function request(payload) {
    if (pending.size >= capacity) throw new Error('The ' + name + ' is busy.');
    const thread = getWorker();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => retire(thread, 'The ' + task + ' timed out.'), 10_000);
      pending.set(id, { resolve, reject, timer });
      try {
        thread.postMessage({ ...payload, id });
      } catch {
        retire(thread, 'The ' + name + ' stopped.');
      }
    });
  }

  return { request, stop: () => retire(worker, 'The ' + task + ' was canceled.') };
}

module.exports = { createWorkerService };
