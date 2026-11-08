const fs = require('node:fs');
const path = require('node:path');
const { startNodeTests } = require('./runner.cjs');

function createTestSession(tempFolder) {
  let state;
  let failedProject;

  async function start(project, retry, publish) {
    if (retry && failedProject !== project.id) throw new Error('Run the project tests first.');
    if (!state) {
      const folder = await fs.promises.mkdtemp(path.join(tempFolder, 'cevra-tests-'));
      state = { folder, attempt: path.join(folder, 'attempt.json'), failed: path.join(folder, 'failed.json') };
    }
    await fs.promises.rm(state.attempt, { force: true });
    if (retry) await fs.promises.copyFile(state.failed, state.attempt);
    let summary;

    async function finish(event) {
      try {
        if (summary && !event.stopped && (event.code === 0 || event.code === 1)) {
          if (summary.success) {
            failedProject = undefined;
          } else {
            await fs.promises.rename(state.attempt, state.failed);
            failedProject = project.id;
          }
        }
        await fs.promises.rm(state.attempt, { force: true });
      } catch (error) {
        publish({ type: 'output', text: '\nCould not update the test retry state. ' + error.message + '\n' });
      }
      publish({ ...event, counts: summary?.counts, retryAvailable: failedProject === project.id });
    }

    return startNodeTests(project, state.attempt, event => {
      if (event.type === 'test-summary') summary = event;
      else if (event.type === 'exit') void finish(event);
      else if (event.type === 'output' || event.type === 'test-failure') publish(event);
    });
  }

  function dispose() {
    if (!state) return;
    try {
      fs.rmSync(state.attempt, { force: true });
      fs.rmSync(state.failed, { force: true });
      fs.rmdirSync(state.folder);
    } catch (error) {
      console.error('Could not remove the test retry state.', error.message);
    }
  }

  return { start, dispose };
}

module.exports = { createTestSession };
