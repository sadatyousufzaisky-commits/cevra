const { createHash } = require('node:crypto');
const { exactRecord } = require('./provider-contract.cjs');
const { verifyRevision } = require('../workspace.cjs');

const lifetimeMs = 15 * 60_000;
const maxSteps = 3;
const plan = Object.freeze([
  'Run project tests with separate approval.',
  'If tests fail, request one edit proposal using the reviewed attachments and test counts.',
  'Review the diff, apply as drafts, and save the approved changes.',
  'Run project tests again with separate approval.',
]);

function createAgentWorkflow(project, { current, publish, runTests, recheckBaseline, retired }) {
  let task;
  const active = () => Boolean(task && !task.controller.signal.aborted);

  function state() {
    if (!task) return { stage: 'idle', plan, maxSteps };
    const { stage, goal, baseline, verification, message, steps, targets } = task;
    return { stage, goal, baseline, verification, message, steps, targets, plan, maxSteps };
  }

  function update(stage, message) {
    task.stage = stage;
    task.message = message;
    publish(state());
  }

  function valid(value, stage) {
    return value && task === value && value.stage === stage && current() === project &&
      !value.controller.signal.aborted && Date.now() < value.expires;
  }

  function check(stage) {
    if (!valid(task, stage)) throw new Error('This coding step is no longer available.');
    return task;
  }

  function takeStep(value) {
    if (value.steps >= maxSteps) {
      finish('stopped', 'The coding task reached its step limit.');
      throw new Error('The coding task reached its step limit.');
    }
    value.steps++;
  }

  function finish(stage, message) {
    if (!task || task.controller.signal.aborted) return;
    task.controller.abort();
    clearTimeout(task.timer);
    task.sources = task.changes = undefined;
    retired();
    update(stage, message);
  }

  async function tests(stage) {
    const value = check(stage);
    const verifying = stage === 'save';
    if (verifying) {
      try { await verifySaved(value); }
      catch {
        if (valid(value, stage)) update('save', 'Save the exact approved edits before verifying.');
        return;
      }
      if (!valid(value, stage)) return;
    }
    const running = verifying ? 'verification' : 'baseline';
    takeStep(value);
    update(running, 'Waiting for test approval and results…');
    try {
      const result = await runTests(project, { verifying, signal: value.controller.signal,
        recheck: verifying ? () => verifySaved(value) : undefined });
      if (!valid(value, running)) return;
      if (!result || result.stopped) { finish('stopped', 'Test execution was canceled.'); return; }
      const counts = result.counts;
      const count = key => Number.isSafeInteger(counts?.[key]) && counts[key] >= 0 ? counts[key] : 0;
      let observed = result.evidence?.freshness === 'observed';
      if (verifying && observed) {
        try {
          await verifySaved(value);
          observed = (await recheckBaseline(project, result.evidence.id))?.freshness === 'observed';
        } catch { observed = false; }
        if (!valid(value, running)) return;
      }
      const summary = { passed: count('passed'), failed: count('failed'), tests: count('tests'),
        exitCode: Number.isInteger(result.code) ? result.code : null, observed };
      value[verifying ? 'verification' : 'baseline'] = summary;
      if (!observed || !summary.tests) {
        finish('unverified', 'The runner did not produce current evidence for a nonempty test suite.');
      } else if (summary.exitCode === 0 && summary.failed === 0 && summary.passed > 0) {
        finish('passed', verifying ? 'The approved change passed the project tests.' : 'The project tests already pass.');
      } else if (!verifying && summary.failed > 0 && typeof result.evidence.id === 'string') {
        value.evidenceId = result.evidence.id;
        update('proposal', 'Tests failed. Review a request for one edit proposal.');
      } else finish('failed', 'The project tests failed.');
    } catch {
      if (valid(value, running)) finish('failed', 'The test step could not finish. Check for unsaved drafts or another workspace action.');
    }
  }

  async function verifySaved(value) {
    const changes = value.changes;
    value.controller.signal.throwIfAborted();
    for (const { path, revision } of changes) {
      value.controller.signal.throwIfAborted();
      await verifyRevision(project, path, revision);
    }
  }

  return {
    state,
    get active() { return active(); },
    prepare(input, sources) {
      if (active()) throw new Error('Stop or finish the current coding task.');
      if (!exactRecord(input, ['goal', 'modelId']) || typeof input.goal !== 'string' || !input.goal.trim() ||
          !input.goal.isWellFormed() || /[\x00-\x1f\x7f]/.test(input.goal) || Buffer.byteLength(input.goal) > 1000 ||
          typeof input.modelId !== 'string' || !sources.some(item => item.kind !== 'instructions') || current() !== project) {
        throw new Error('Enter a coding goal and attach an editor selection or saved file.');
      }
      const timer = setTimeout(() => finish('stopped', 'The coding task reached its time limit.'), lifetimeMs);
      timer.unref();
      task = { stage: 'plan', goal: input.goal.trim(), modelId: input.modelId, steps: 0, sources: Object.freeze([...sources]),
        targets: sources.map(({ kind, path, line, endLine }) => ({ kind, path, line, endLine })),
        controller: new AbortController(), timer, expires: Date.now() + lifetimeMs };
      update('plan', 'Review the coding plan before starting.');
    },
    baseline: () => tests('plan'),
    verify: () => tests('save'),
    async beginProposal(modelId) {
      const value = check('proposal');
      if (modelId !== value.modelId) throw new Error('Use the model selected in the plan.');
      takeStep(value);
      update('generating', 'Preparing the edit proposal for review.');
      const recheck = async () => {
        const evidence = await recheckBaseline(project, value.evidenceId);
        if (!valid(value, 'generating') || evidence?.freshness !== 'observed') {
          throw new Error('The baseline test evidence is no longer current.');
        }
      };
      try {
        await recheck();
      } catch {
        if (valid(value, 'generating')) finish('unverified', 'The baseline test evidence changed. Start a new coding task.');
        throw new Error('The baseline test evidence is no longer current.');
      }
      return { sources: value.sources, goal: value.goal, signal: value.controller.signal, recheck,
        feedback: JSON.stringify(value.baseline) };
    },
    proposalReady() {
      check('generating');
      update('review', 'Review the proposed edits in the workbench.');
    },
    applied(changes) {
      if (!valid(task, 'review')) return;
      task.changes = changes.map(({ path, text }) => ({ path, revision: createHash('sha256').update(text).digest('hex') }));
      update('save', 'Save the approved drafts in the workbench, then verify.');
    },
    proposalRetired() {
      if (valid(task, 'review')) finish('stopped', 'The edit proposal is no longer available.');
    },
    stop: (message = 'Coding task stopped.') => finish('stopped', message),
  };
}

module.exports = { createAgentWorkflow };
