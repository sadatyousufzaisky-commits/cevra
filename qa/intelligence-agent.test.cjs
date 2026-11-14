const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAgentWorkflow } = require('../src/intelligence/agent-workflow.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createWorkspace } = require('../src/workspace.cjs');
const { temporaryFolder } = require('./temp.cjs');

const failure = { code: 1, counts: { tests: 1, failed: 1, passed: 0 }, evidence: { id: 'baseline', freshness: 'observed' },
  output: { text: 'PRIVATE TEST STDOUT' }, failures: [{ message: 'PRIVATE FAILURE' }] };
const success = { code: 0, counts: { tests: 1, failed: 0, passed: 1 }, evidence: { id: 'verified', freshness: 'observed' } };
const input = { modelId: 'selected-model', goal: 'Fix the failing calculation' };
const source = { id: 'test-target', kind: 'selection', path: 'main.js', line: 1, endLine: 1 };

async function setup(t, callbacks = {}) {
  const root = await temporaryFolder(t, 'cevra-agent-');
  const file = path.join(root, source.path);
  await fs.writeFile(file, 'before');
  const project = await createWorkspace(root);
  const calls = [];
  const states = [];
  let current = project;
  let retires = 0;
  const agent = createAgentWorkflow(project, {
    current: () => current,
    publish: state => states.push(state),
    runTests: async (_project, options) => {
      calls.push(options.verifying);
      if (callbacks.runTests) return callbacks.runTests(options);
      await options.recheck?.();
      return options.verifying ? success : failure;
    },
    recheckBaseline: callbacks.recheckBaseline ?? (async () => failure.evidence),
    retired: () => { retires++; },
  });
  return { agent, project, file, calls, states, retires: () => retires, switchWorkspace: () => { current = undefined; } };
}

test('coding task consumes exactly two test steps and one scoped proposal', async t => {
  const { agent, file, calls, states } = await setup(t);
  assert.throws(() => agent.prepare({ ...input, tool: 'shell' }, [source]), /coding goal/i);
  agent.prepare(input, [source]);
  assert.deepEqual(calls, []);
  await assert.rejects(agent.verify(), /no longer available/i);
  await agent.baseline();
  assert.deepEqual(calls, [false]);
  assert.equal(agent.state().stage, 'proposal');
  await assert.rejects(agent.beginProposal('another-model'), /model selected/i);
  const request = await agent.beginProposal(input.modelId);
  assert.deepEqual(request.sources, [source]);
  assert.deepEqual(JSON.parse(request.feedback), { passed: 0, failed: 1, tests: 1, exitCode: 1, observed: true });
  await assert.rejects(agent.beginProposal(input.modelId), /no longer available/i);
  agent.proposalReady();
  agent.applied([{ path: source.path, text: 'after' }]);
  await agent.verify();
  assert.deepEqual(calls, [false]);
  assert.equal(agent.state().stage, 'save');
  await fs.writeFile(file, 'after');
  await agent.verify();
  assert.equal(agent.state().stage, 'passed');
  assert.equal(agent.state().steps, 3);
  assert.deepEqual(calls, [false, true]);
  assert.doesNotMatch(JSON.stringify(states), /PRIVATE/);
  await assert.rejects(agent.baseline(), /no longer available/i);
});

test('stop aborts a running step and ignores late results', async t => {
  const started = Promise.withResolvers();
  const late = Promise.withResolvers();
  const { agent, calls, retires } = await setup(t, {
    runTests({ signal }) { started.resolve(signal); return late.promise; },
  });
  agent.prepare(input, [source]);
  const test = agent.baseline();
  const signal = await started.promise;
  agent.stop();
  assert.equal(signal.aborted, true);
  late.resolve(failure);
  await test;
  assert.equal(agent.state().stage, 'stopped');
  assert.equal(retires(), 1);
  await assert.rejects(agent.beginProposal(input.modelId), /no longer available/i);
  assert.deepEqual(calls, [false]);
});

test('workspace changes and stale test evidence prevent proposal admission', async t => {
  const stale = await setup(t, { recheckBaseline: async () => ({ freshness: 'historical' }) });
  stale.agent.prepare(input, [source]);
  await stale.agent.baseline();
  await assert.rejects(stale.agent.beginProposal(input.modelId), /no longer current/i);
  assert.equal(stale.agent.state().stage, 'unverified');
  const f = await setup(t);
  f.agent.prepare(input, [source]);
  f.switchWorkspace();
  await assert.rejects(f.agent.baseline(), /no longer available/i);
  f.agent.stop();
  assert.deepEqual(f.calls, []);
});
