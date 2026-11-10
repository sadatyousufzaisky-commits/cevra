const { randomUUID } = require('node:crypto');
const { captureInputs, createRunEvidence, inputFreshness, sourceAnchor } = require('./revisions.cjs');

function createTestWorkstream(workspace, startTests, history) {
  const workstreamId = history?.workstreamId ?? randomUUID();
  const observed = createRunEvidence(workspace);

  async function start(retry, goal, publish, isStopping) {
    if (typeof goal !== 'string' || goal.length > 120 || /[\r\n\0]/.test(goal)) throw new Error('Enter a workstream goal of up to 120 characters.');
    observed.clear();
    const id = randomUUID();
    const [before, retention] = await Promise.all([captureInputs(workspace), history?.admit()]);
    const failures = [];

    async function finish(event) {
      const after = event.stopped || isStopping() ? { files: new Map() } : await captureInputs(workspace);
      const stopped = Boolean(event.stopped || isStopping());
      const freshness = stopped ? 'unavailable' : inputFreshness(before, after);
      const outcome = stopped ? 'cancelled' : event.code !== 0 || !event.counts ? 'failed' :
        event.counts.tests === 0 ? 'empty' : 'passed';
      const evidence = {
        schemaVersion: 1, id, workstreamId, workspaceId: workspace.id, goal: goal.trim() || 'Project tests',
        revision: before.revision, fileCount: before.files.size, freshness, outcome, retry,
        exitCode: event.code, durationMs: event.elapsed,
      };
      observed.remember(evidence, before);
      history?.record(retention, evidence);
      publish({
        ...event, stopped, evidence,
        failures: failures.map(failure => ({
          ...failure, anchor: sourceAnchor(workspace, failure.location, before, after),
        })),
      });
    }

    if (isStopping()) {
      await finish({ type: 'exit', code: null, stopped: true, elapsed: 0 });
      return;
    }
    let finished = false;
    return startTests(workspace, retry, event => {
      if (finished) return;
      if (event.type === 'test-failure') {
        if (failures.length < 100) failures.push(event);
      } else if (event.type === 'exit') {
        finished = true;
        void finish(event);
      } else {
        publish(event);
      }
    }, isStopping);
  }

  return { start, recheck: observed.recheck };
}

module.exports = { createTestWorkstream };
