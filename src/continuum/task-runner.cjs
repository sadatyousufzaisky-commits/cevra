const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { stripVTControlCharacters } = require('node:util');
const { startProcess } = require('../execution/process-host.cjs');
const { sourceLocation } = require('../source-location.cjs');
const { inside, resolveEntry, workspacePath } = require('../workspace.cjs');
const { captureInputs, createRunEvidence, inputFreshness, sourceAnchor } = require('./revisions.cjs');
const { readTaskCatalog } = require('./task-catalog.cjs');
const { planTask } = require('./task-plan.cjs');

const changedPlan = 'Task scripts or dependencies changed. Refresh Tasks and review the plan.';

async function findNpm(root) {
  const folders = (process.env.PATH ?? '').split(path.delimiter).map(folder => folder.replace(/^"|"$/g, '')).filter(folder => path.isAbsolute(folder));
  const candidates = [process.env.npm_execpath, ...folders.flatMap(folder => [
    path.join(folder, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(folder, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(process.platform === 'win32' ? [] : [path.join(folder, 'npm')]),
  ])];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate) || inside(root, candidate)) continue;
    const file = await fs.realpath(candidate).catch(() => null);
    if (file && path.basename(file).toLowerCase() === 'npm-cli.js' && !inside(root, file) &&
        (await fs.stat(file).catch(() => null))?.isFile()) return file;
  }
  throw new Error('CEVRA could not find npm in your Node.js installation. Install Node.js with npm and restart CEVRA.');
}

function taskLocation(workspace, output) {
  const text = stripVTControlCharacters(output);
  for (const line of text.split(/\r?\n/)) {
    const match = /^(.*)\((\d+),(\d+)\): error TS\d+:/.exec(line.trim()) ??
      /^(.*):(\d+):(\d+)\s+- error TS\d+:/.exec(line.trim());
    if (!match || !/\.[cm]?[jt]sx?$/i.test(match[1])) continue;
    const relative = path.isAbsolute(match[1]) ? path.relative(workspace.root, match[1]) : match[1];
    try {
      return { path: path.relative(workspace.root, workspacePath(workspace, relative)), line: Number(match[2]), column: Number(match[3]) };
    } catch {}
  }
  return sourceLocation(workspace.root, text);
}

function createTaskRunner(workspace, history) {
  const observed = createRunEvidence(workspace);

  async function start(target, revision, publish, isSessionStopping) {
    observed.clear();
    const catalog = await readTaskCatalog(workspace);
    if (catalog.revision !== revision) throw new Error(changedPlan);
    const plan = planTask(catalog, target);
    const [npm, retention] = await Promise.all([findNpm(workspace.root), history.admit()]);
    const started = performance.now();
    const results = new Map();
    let active;
    let invalidPlan;
    let evidence;
    let stopped = false;
    const isStopping = () => stopped || isSessionStopping();

    function complete(task, outcome, event, before, after, reason, location) {
      const result = { id: task.id, outcome, exitCode: event?.code ?? null, durationMs: event?.elapsed ?? 0, reason };
      const capsule = {
        id: randomUUID(), kind: 'task', taskId: task.id, workspaceId: workspace.id, workstreamId: history.workstreamId,
        revision: before?.revision, fileCount: before?.files.size ?? 0,
        freshness: before && after ? inputFreshness(before, after) : 'unavailable',
        outcome, exitCode: result.exitCode, durationMs: result.durationMs, retry: false,
      };
      if (task === plan.at(-1)) {
        evidence = capsule;
        observed.remember(capsule, before, catalog.outputs);
      }
      if (location && before && after) result.anchor = sourceAnchor(workspace, location, before, after);
      history.record(retention, capsule);
      results.set(task.id, result);
      publish({ type: 'task-progress', ...result });
    }

    async function execute(task) {
      const before = await captureInputs(workspace, catalog.outputs);
      let root;
      try {
        if ((await readTaskCatalog(workspace)).revision !== revision) throw new Error(changedPlan);
        root = await resolveEntry(workspace, '');
      } catch {
        invalidPlan = changedPlan;
        complete(task, isStopping() ? 'blocked' : 'failed', null, null, null,
          isStopping() ? 'Run canceled' : invalidPlan);
        return;
      }
      if (isStopping()) {
        complete(task, 'blocked', null, null, null, 'Run canceled');
        return;
      }
      publish({ type: 'task-progress', id: task.id, outcome: 'running' });
      publish({ type: 'output', text: '\n[Task ' + task.id + ' · npm run ' + task.profile + ']\n' });
      let output = '';
      const event = await new Promise(resolve => {
        active = startProcess(root, [npm, '--prefix', root, '--ignore-scripts', '--workspaces=false',
          '--logs-max=0', '--no-update-notifier', 'run', task.profile], event => {
          if (event.type === 'exit') resolve(event);
          else {
            output = ((event.truncated ? '' : output) + event.text).slice(-32_768);
            publish(event);
          }
        });
      });
      active = undefined;
      const after = event.stopped || isStopping() ? null : await captureInputs(workspace, catalog.outputs);
      const outcome = event.stopped || isStopping() ? 'cancelled' : event.code === 0 ? 'passed' : 'failed';
      const location = outcome === 'failed' ? taskLocation(workspace, (event.stderr ?? '').slice(-32_768) + '\n' + output) : null;
      complete(task, outcome, event, before, outcome === 'cancelled' ? null : after, event.error, location);
    }

    async function run() {
      for (const task of plan) {
        const blocker = task.after.find(id => {
          const outcome = results.get(id).outcome;
          return outcome !== 'passed' && !(task.continueOnFailure && outcome === 'failed');
        });
        const reason = isStopping() ? 'Run canceled' : invalidPlan || (blocker && 'Dependency ' + blocker + ' did not pass');
        if (reason) complete(task, 'blocked', null, null, null, reason);
        else await execute(task);
      }
      const failure = [...results.values()].find(result => result.outcome === 'failed');
      publish({
        type: 'exit', code: isStopping() ? null : failure ? failure.exitCode : 0, stopped: isStopping(),
        elapsed: Math.round(performance.now() - started), evidence,
        completedWithFailures: Boolean(failure && evidence?.outcome === 'passed'),
      });
    }

    void run().catch(error => {
      for (const task of plan) {
        if (!results.has(task.id)) complete(task, 'blocked', null, null, null, 'Task execution could not continue');
      }
      publish({ type: 'exit', code: null, elapsed: Math.round(performance.now() - started), error: error.message });
    });
    return {
      stop() {
        stopped = true;
        active?.stop();
      },
    };
  }

  return { start, recheck: observed.recheck };
}

module.exports = { createTaskRunner };
