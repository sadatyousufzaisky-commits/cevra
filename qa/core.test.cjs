const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { stripVTControlCharacters } = require('node:util');
const { temporaryFolder } = require('./temp.cjs');
const { createWorkspace, listFolder, readSource, saveSource, saveRecoveryCopy } = require('../src/workspace.cjs');
const { startNodeRun, startNodeTests } = require('../src/runner.cjs');
const { createDraftStore } = require('../src/drafts.cjs');
const { writeAtomic } = require('../src/atomic-file.cjs');
const { searchProject } = require('../src/project-search.cjs');
const { createSyntaxService } = require('../src/syntax-service.cjs');
const { createFormatService } = require('../src/format-service.cjs');
const { createSemanticService } = require('../src/semantic-service.cjs');
const { createPreferences } = require('../src/preferences.cjs');
const { createFlightpathStore } = require('../src/continuum/flightpath.cjs');
const { captureInputs, inputFreshness, sourceAnchor } = require('../src/continuum/revisions.cjs');
const { createTestWorkstream } = require('../src/continuum/workstream.cjs');
const { readTaskCatalog } = require('../src/continuum/task-catalog.cjs');
const { planTask } = require('../src/continuum/task-plan.cjs');
const { createTaskRunner } = require('../src/continuum/task-runner.cjs');
const { createExecutionSessions } = require('../src/execution/sessions.cjs');
const { createPythonProfiles } = require('../src/execution/python-profiles.cjs');
const { pythonColumn, pythonDiagnostic } = require('../src/execution/runtime-location.cjs');
const { createTerminalSessions } = require('../src/execution/terminal-sessions.cjs');
const { maxOutput } = require('../src/execution/process-host.cjs');
const { createReportDecoder, encodeReport } = require('../src/execution/test-report.cjs');

async function fixture(t) {
  const folder = await temporaryFolder(t, 'cevra-core-');
  const root = path.join(folder, 'project (QA) # % & café');
  await fs.mkdir(root);
  return { folder, root, workspace: await createWorkspace(root) };
}

test('Python profiles discover workspace environments without running them and reject changed selections', async t => {
  const { root, workspace } = await fixture(t);
  const profiles = createPythonProfiles(workspace, '');
  assert.deepEqual(await profiles.list(), []);
  await assert.rejects(profiles.resolve('missing'), /Choose a Python interpreter/);
  const venv = path.join(root, '.venv');
  const bin = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin');
  const python = path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python3');
  const config = path.join(venv, 'pyvenv.cfg');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(python, 'this file is deliberately not executable Python', { mode: 0o700 });
  assert.deepEqual(await profiles.list(), []);
  await fs.writeFile(config, 'home = first\n');
  const [local] = await profiles.list();
  assert.equal(local.label, 'Workspace .venv');
  assert.equal((await profiles.resolve(local.id)).file, python);
  await fs.writeFile(config, 'home = second\n');
  await assert.rejects(profiles.resolve(local.id), /interpreter changed or is unavailable/);
  const [updated] = await profiles.list();
  assert.notEqual(updated.id, local.id);
  await fs.rename(python, python + '.removed');
  await assert.rejects(profiles.resolve(updated.id), /interpreter changed or is unavailable/);
});

test('Python traceback navigation uses the latest exception and maps a proven caret', async t => {
  const { root, folder } = await fixture(t);
  const outside = path.join(folder, 'outside.py');
  const traceback = [
    'Traceback (most recent call last):',
    '  File "first.py", line 9, in <module>',
    'RuntimeError: earlier failure',
    '',
    'The above exception was the direct cause of the following exception:',
    '',
    'Traceback (most recent call last):',
    '  File "nested (QA)/target café.py", line 3, in <module>',
    '    raise ValueError("final")',
    '          ^^^^^^^^^^',
    '  File "' + outside + '", line 99, in runtime',
    'ValueError: final failure',
  ].join('\r\n');
  const { location, pointer, summary } = pythonDiagnostic(root, traceback);
  assert.deepEqual(location, { path: path.join('nested (QA)', 'target café.py'), line: 3, column: 1 });
  assert.equal(summary, 'ValueError: final failure');
  assert.equal(pythonColumn('  raise ValueError("final")', pointer), 9);
  assert.equal(pythonColumn('  unrelated source', pointer), 1);
});

test('Windows terminal sessions enforce scope and bound input and output reads',
  { timeout: 12_000, skip: process.platform !== 'win32' }, async t => {
    const { root, workspace } = await fixture(t);
    const terminals = createTerminalSessions();
    t.after(() => terminals.closeAll());
    assert.throws(() => terminals.start(workspace.id, root, 'custom', 80, 24), /supported terminal profile/);
    const { id } = terminals.start(workspace.id, root, 'cmd', 80, 24);
    assert.throws(() => terminals.read('another workspace', id), /session has closed/);
    assert.throws(() => terminals.write(workspace.id, id, 'é'.repeat(8193)), /16 KiB/);
    await assert.rejects(terminals.resize(workspace.id, id, 0, 24), /Invalid terminal size/);
    await assert.rejects(terminals.close('another workspace', id), /session has closed/);
    await terminals.write(workspace.id, id, 'for /L %n in (1,1,2200) do @echo CEVRA-FLOOD-0123456789-%n\r');
    await terminals.write(workspace.id, id, 'echo CEVRA-CORE&exit /b 3\r');
    const output = [];
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const { data, exit } = terminals.read(workspace.id, id);
      if (data) {
        assert.ok(data.length <= 32 * 1024);
        output.push(data);
      }
      if (exit) {
        assert.equal(exit.code, 3, exit.error);
        const received = Buffer.concat(output);
        assert.ok(received.length > 32 * 1024);
        const withoutTitles = received.toString('utf8').replace(/\x1b\]0;[^\x07]*\x07/g, '');
        assert.match(stripVTControlCharacters(withoutTitles).slice(-1000),
          /CEVRA-FLOOD-0123456789-2200[\s\S]*CEVRA-CORE\r\n/);
        await terminals.close(workspace.id, id);
        assert.throws(() => terminals.read(workspace.id, id), /session has closed/);
        return;
      }
      await delay(20);
    }
    assert.fail('Command Prompt did not exit. ' + Buffer.concat(output).toString('utf8').slice(-2000));
  });

test('execution sessions reject stale owners, keep a bounded output tail, and settle cancellation once', async () => {
  const events = [];
  const sessions = createExecutionSessions(event => events.push(event));
  let emit;
  let admit;
  let stops = 0;
  const launch = sessions.start('first', 1, 'token-1', publish => {
    emit = publish;
    return new Promise(resolve => { admit = resolve; });
  });
  assert.equal(sessions.busy, true);
  assert.equal(sessions.stop('second', 1, 'token-1'), false);
  assert.equal(sessions.stop('first', 1, 'token-expired'), false);
  assert.equal(sessions.output('first', 1, 'token-expired', 0), null);
  await assert.rejects(sessions.start('second', 2, 'token-2', () => {}), /already running/);
  emit({ type: 'output', text: 'a'.repeat(maxOutput) });
  emit({ type: 'output', text: 'tail café' });
  const output = sessions.output('first', 1, 'token-1', 0);
  assert.equal(output.text.length, maxOutput);
  assert.equal(output.truncated, true);
  assert.equal(output.reset, true);
  assert.ok(output.text.endsWith('tail café'));
  assert.equal(sessions.output('first', 1, 'token-1', output.cursor).text, '');
  assert.equal(events.length, 0);
  assert.equal(sessions.stop('first', 1, 'token-1'), true);
  const canceled = sessions.cancel();
  admit({ stop: () => { stops++; } });
  await launch;
  assert.equal(stops, 1);
  emit({ type: 'exit', code: 0 });
  emit({ type: 'exit', code: 1 });
  await canceled;
  assert.equal(events.length, 1);
  assert.equal(events[0].stopped, true);
  assert.equal(events[0].sessionId, 'token-1');
  assert.equal(events[0].output.text, output.text);
  assert.equal(sessions.busy, false);
  await sessions.start('second', 1, 'token-2', publish => publish({ type: 'exit', code: 0 }));
  assert.equal(events[1].stopped, false);
  assert.equal(events[1].workspaceId, 'second');
});

test('test report decoder preserves output and accepts only bounded, complete records', () => {
  const events = [];
  const text = [];
  const prefix = 'CEVRA-opaque ';
  const decoder = createReportDecoder(prefix, event => events.push(event), chunk => text.push(chunk));
  const failure = { type: 'test-failure', name: 'total', message: 'incorrect', location: null };
  const frame = encodeReport(prefix, failure);
  decoder.write(frame.slice(0, 7));
  decoder.write(frame.slice(7) + encodeReport(prefix, { type: 'output', text: prefix + 'literal café\n' }));
  const oversized = prefix + 'x'.repeat(61_000);
  decoder.write(oversized);
  decoder.write('\n' + encodeReport(prefix, { ...failure, message: 1 }) + 'trailing');
  decoder.finish();
  assert.deepEqual(events, [failure]);
  assert.equal(text.join(''), prefix + 'literal café\n' + oversized + '\n' +
    encodeReport(prefix, { ...failure, message: 1 }) + 'trailing');
});

test('workspace observations cover configuration and binary inputs and reject unsafe anchors', async t => {
  const { root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'entry.cjs'), 'throw new Error();\n');
  await fs.writeFile(path.join(root, 'config.json'), '{}\n');
  await fs.writeFile(path.join(root, 'sample.bin'), Buffer.from([0, 255]));
  const before = await captureInputs(workspace);
  assert.equal(before.files.size, 3);
  assert.match(before.revision, /^[0-9a-f]{64}$/);
  const location = { path: 'entry.cjs', line: 1, column: 7 };
  const anchor = sourceAnchor(workspace, location, before, before);
  assert.deepEqual(anchor, { ...location, revision: (await readSource(workspace, 'entry.cjs')).revision });
  for (const path of ['C:outside.js', 'entry.cjs:stream', '../entry.cjs']) {
    assert.equal(sourceAnchor(workspace, { ...location, path }, before, before), null);
  }

  await fs.writeFile(path.join(root, 'config.json'), '{"changed":true}\n');
  const configChanged = await captureInputs(workspace);
  assert.equal(inputFreshness(before, configChanged), 'historical');
  assert.deepEqual(sourceAnchor(workspace, location, before, configChanged), anchor);
  await fs.utimes(path.join(root, 'entry.cjs'), new Date(), new Date(1_700_000_000_000));
  const touched = await captureInputs(workspace);
  assert.equal(touched.revision, configChanged.revision);
  assert.equal(inputFreshness(configChanged, touched), 'historical');
  assert.equal(sourceAnchor(workspace, location, configChanged, touched), null);

  await fs.writeFile(path.join(root, 'oversized.bin'), Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.equal(inputFreshness(touched, await captureInputs(workspace)), 'unavailable');
});

test('workstream evidence stays tied to its attempt and cancellation wins over a late pass', async t => {
  const { root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'fixture.cjs'), 'const count = 1;\n');
  let publishTest;
  let stopping = false;
  const workstream = createTestWorkstream(workspace, async (_workspace, _retry, publish) => {
    publishTest = publish;
  });
  async function attempt(retry, event, beforeExit = () => {}) {
    let publish;
    const finished = new Promise(resolve => { publish = resolve; });
    await workstream.start(retry, 'Check totals', publish, () => stopping);
    await beforeExit();
    publishTest({ type: 'exit', elapsed: 17, counts: { tests: 1 }, ...event });
    return finished;
  }

  const failure = await attempt(false, { code: 1 }, () => {
    publishTest({
      type: 'test-failure', name: 'totals', message: 'unexpected count',
      location: { path: 'fixture.cjs', line: 1, column: 7 },
    });
  });
  assert.equal(failure.evidence.goal, 'Check totals');
  assert.equal(failure.evidence.workspaceId, workspace.id);
  assert.equal(failure.evidence.outcome, 'failed');
  assert.equal(failure.evidence.freshness, 'observed');
  assert.equal(failure.failures[0].anchor.revision, (await readSource(workspace, 'fixture.cjs')).revision);
  await fs.writeFile(path.join(root, 'fixture.cjs'), 'const count = 2;\n');
  const checks = await Promise.all([workstream.recheck(failure.evidence.id), workstream.recheck(failure.evidence.id)]);
  assert.equal(checks[0], checks[1]);
  assert.equal(checks[0].freshness, 'historical');

  const changed = await attempt(true, { code: 1 }, async () => {
    publishTest({ type: 'test-failure', location: { path: 'fixture.cjs', line: 1, column: 7 } });
    await fs.writeFile(path.join(root, 'fixture.cjs'), 'const count = 3;\n');
  });
  assert.equal(changed.evidence.freshness, 'historical');
  assert.equal(changed.failures[0].anchor, null);
  assert.equal(changed.evidence.workstreamId, failure.evidence.workstreamId);
  assert.notEqual(changed.evidence.id, failure.evidence.id);
  assert.equal(await workstream.recheck(failure.evidence.id), null);

  const cancelled = await attempt(true, { code: 0 }, () => { stopping = true; });
  assert.equal(cancelled.stopped, true);
  assert.equal(cancelled.evidence.outcome, 'cancelled');
  assert.equal(cancelled.evidence.freshness, 'unavailable');
});

test('Flightpath persists only bounded capsule metadata for the original workspace', async t => {
  const { folder, root, workspace } = await fixture(t);
  const directory = path.join(folder, 'profile', 'flightpath');
  const store = createFlightpathStore(directory);
  const history = store.forWorkspace(workspace);
  const makeEvidence = () => ({
    id: randomUUID(), revision: 'a'.repeat(64), outcome: 'passed', freshness: 'observed',
    retry: false, exitCode: 0, durationMs: 13, goal: 'private goal', output: 'private output',
    args: ['secret argument'], environment: { TOKEN: 'secret token' },
  });

  history.record(await history.admit(), makeEvidence());
  assert.equal((await history.view()).enabled, false);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  const { limit } = await history.enable();
  const generation = await history.admit();
  const attempts = Array.from({ length: limit + 2 }, makeEvidence);
  for (const attempt of attempts) history.record(generation, attempt);
  history.record(generation, attempts.at(-1));
  await store.flush();

  const journal = path.join(directory, history.workstreamId, 'journal.json');
  const saved = await fs.readFile(journal, 'utf8');
  assert.doesNotMatch(saved, /private goal|private output|secret argument|secret token|project \(QA\)/);
  const reopened = createFlightpathStore(directory).forWorkspace(await createWorkspace(root));
  const { enabled, capsules } = await reopened.view();
  assert.equal(enabled, true);
  assert.deepEqual(capsules.map(capsule => capsule.id), attempts.slice(-limit).map(attempt => attempt.id));
  assert.deepEqual(Object.keys(capsules[0]).sort(),
    ['completedAt', 'durationMs', 'exitCode', 'freshness', 'id', 'kind', 'outcome', 'retry', 'revision', 'workstreamId']);

  await fs.rename(root, root + ' old');
  await fs.mkdir(root);
  const replacement = store.forWorkspace(await createWorkspace(root));
  assert.equal((await replacement.view()).enabled, false);
  assert.notEqual(replacement.workstreamId, history.workstreamId);
});

test('Flightpath clear and opt-out reject late results and unreadable history fails closed', async t => {
  const { folder, workspace } = await fixture(t);
  const directory = path.join(folder, 'flightpath');
  const store = createFlightpathStore(directory);
  const history = store.forWorkspace(workspace);
  const result = {
    id: randomUUID(), revision: 'a'.repeat(64), outcome: 'passed', freshness: 'observed',
    retry: false, exitCode: 0, durationMs: 13,
  };
  await history.enable();
  const first = await history.admit();
  const journal = path.join(directory, history.workstreamId, 'journal.json');
  const interrupted = path.join(path.dirname(journal), '.cevra-' + randomUUID() + '.tmp');
  await fs.writeFile(interrupted, 'uncommitted capsule');
  const clearing = history.clear();
  history.record(first, result);
  await clearing;
  assert.deepEqual((await history.view()).capsules, []);
  await assert.rejects(fs.stat(interrupted), { code: 'ENOENT' });

  const second = await history.admit();
  const disabling = history.disable();
  const enabling = history.enable();
  history.record(second, result);
  await Promise.all([disabling, enabling]);
  assert.deepEqual((await history.view()).capsules, []);

  history.record(await history.admit(), result);
  assert.equal((await history.view()).capsules[0].id, result.id);
  const changed = JSON.parse(await fs.readFile(journal, 'utf8'));
  changed.data.capsules[0].revision = 'b'.repeat(64);
  await fs.writeFile(journal, JSON.stringify(changed));
  const invalid = await history.view();
  assert.equal(invalid.unreadable, true);
  assert.deepEqual(invalid.capsules, []);
  assert.equal(await history.admit(), undefined);
  await assert.rejects(history.enable(), /Invalid Flightpath journal/);
  assert.equal((await history.disable()).enabled, false);
  await assert.rejects(fs.stat(journal), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.dirname(journal)), { code: 'ENOENT' });
});

test('Task Weave discovers scripts read-only and validates an ordered dependency closure', async t => {
  const { root, workspace } = await fixture(t);
  const manifest = path.join(root, 'package.json');
  const config = path.join(root, '.cevra-tasks.json');
  const script = 'node -e "require(\'node:fs\').writeFileSync(\'ran\', \'yes\')"';
  await fs.writeFile(manifest, '\uFEFF' + JSON.stringify({ scripts: { check: script, '-unsafe': 'echo ignored' } }));
  const tasks = [
    { id: 'all', profile: 'check', after: ['left', 'right'] },
    { id: 'left', profile: 'check', after: ['base'] },
    { id: 'right', profile: 'check', after: ['base'] },
    { id: 'base', profile: 'check', after: [] },
    { id: 'unrelated', profile: 'check', after: [] },
  ];
  const writeGraph = (steps, outputs) => fs.writeFile(config, JSON.stringify({ schemaVersion: 1, tasks: steps, outputs }));
  await writeGraph(tasks, ['generated']);
  const catalog = await readTaskCatalog(workspace);
  assert.deepEqual(catalog.scripts, [{ id: 'check', command: script }]);
  assert.equal(catalog.omitted, 1);
  assert.deepEqual(planTask(catalog, 'dag:all').map(task => task.id), ['base', 'left', 'right', 'all']);
  assert.deepEqual(planTask(catalog, 'npm:check').map(task => task.id), ['check']);
  assert.throws(() => planTask(catalog, 'npm:-unsafe'), /current catalog/);
  await assert.rejects(fs.stat(path.join(root, 'ran')), { code: 'ENOENT' });

  await writeGraph(tasks.map(task => task.id === 'base' ? { ...task, after: ['all'] } : task));
  await assert.rejects(readTaskCatalog(workspace), /Circular task dependency/);
  await writeGraph(tasks.slice(0, 3));
  await assert.rejects(readTaskCatalog(workspace), /Missing task dependency base/);
  await writeGraph([...tasks, tasks[0]]);
  await assert.rejects(readTaskCatalog(workspace), /unique ID/);
  await writeGraph([{ ...tasks[3], profile: 'missing' }]);
  await assert.rejects(readTaskCatalog(workspace), /unavailable script missing/);
  await writeGraph(tasks, ['../elsewhere']);
  await assert.rejects(readTaskCatalog(workspace), /relative folder paths/);
});

test('supervised npm tasks can continue after an opted-in failure and migrate older Flightpath records',
  { timeout: 25_000 }, async t => {
    const { folder, root, workspace } = await fixture(t);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {
      check: 'node steps.cjs check', build: 'node steps.cjs build', test: 'node steps.cjs test', prebuild: 'node steps.cjs implicit',
    } }));
    await fs.writeFile(path.join(root, '.cevra-tasks.json'), JSON.stringify({ schemaVersion: 1, outputs: ['dist'], tasks: [
      { id: 'check', profile: 'check', after: [] },
      { id: 'build', profile: 'build', after: ['check'], continueOnFailure: true },
      { id: 'verify', profile: 'test', after: ['build'] },
    ] }));
    await fs.writeFile(path.join(root, 'steps.cjs'), `
      const fs = require('node:fs');
      const step = process.argv[2];
      if (step === 'check') {
        console.error('steps.cjs(2,7): error TS2322: Example task diagnostic');
        process.exit(7);
      }
      if (step === 'implicit') fs.writeFileSync('ran-implicit', 'yes');
      if (step === 'build') {
        fs.mkdirSync('dist');
        fs.writeFileSync('dist/built', 'artifact');
      }
      if (step === 'test' && fs.readFileSync('dist/built', 'utf8') !== 'artifact') process.exit(3);
    `);
    const storage = path.join(folder, 'flightpath');
    const store = createFlightpathStore(storage);
    const history = store.forWorkspace(workspace);
    await history.enable();
    const legacyId = randomUUID();
    history.record(await history.admit(), {
      id: legacyId, revision: 'a'.repeat(64), outcome: 'passed', freshness: 'observed', retry: false, exitCode: 0, durationMs: 5,
    });
    await store.flush();
    const journal = path.join(storage, history.workstreamId, 'journal.json');
    const { data } = JSON.parse(await fs.readFile(journal, 'utf8'));
    data.version = 1;
    await fs.writeFile(journal, JSON.stringify({ data, checksum: createHash('sha256').update(JSON.stringify(data)).digest('hex') }));
    assert.equal((await history.view()).capsules[0].id, legacyId);

    const catalog = await readTaskCatalog(workspace);
    const runner = createTaskRunner(workspace, history);
    const events = [];
    const { promise, resolve } = Promise.withResolvers();
    const controller = await runner.start('dag:verify', catalog.revision, event => {
      events.push(event);
      if (event.type === 'exit') resolve(event);
    }, () => false);
    t.after(() => controller.stop());
    const exit = await promise;
    assert.equal(exit.code, 7, events.map(event => event.text || event.reason || '').join('').slice(-3000));
    assert.equal(exit.completedWithFailures, true);
    assert.equal(exit.evidence.freshness, 'observed');
    assert.deepEqual(events.filter(event => event.type === 'task-progress').map(event => [event.id, event.outcome]), [
      ['check', 'running'], ['check', 'failed'], ['build', 'running'], ['build', 'passed'], ['verify', 'running'], ['verify', 'passed'],
    ]);
    const { anchor } = events.find(event => event.id === 'check' && event.outcome === 'failed');
    assert.deepEqual([anchor.path, anchor.line, anchor.column], ['steps.cjs', 2, 7]);
    assert.match(anchor.revision, /^[a-f0-9]{64}$/);
    await assert.rejects(fs.stat(path.join(root, 'ran-implicit')), { code: 'ENOENT' });
    await store.flush();
    const migrated = JSON.parse(await fs.readFile(journal, 'utf8'));
    assert.equal(migrated.data.version, 2);
    assert.deepEqual((await history.view()).capsules.map(item => item.taskId ?? item.id), [legacyId, 'check', 'build', 'verify']);
    assert.equal((await runner.recheck(exit.evidence.id)).freshness, 'observed');
    await fs.writeFile(path.join(root, 'steps.cjs'), '// Changed after verification.');
    assert.equal((await runner.recheck(exit.evidence.id)).freshness, 'historical');
  });

test('Task Weave stops the graph if a running script changes the approved manifest', { timeout: 15_000 }, async t => {
  const { folder, root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {
    build: 'node rewrite.cjs', verify: 'echo ORIGINAL-STEP', finish: 'echo FINAL-STEP',
  } }));
  await fs.writeFile(path.join(root, 'rewrite.cjs'), `
    const fs = require('node:fs');
    const data = require('./package.json');
    data.scripts.verify = 'echo CHANGED-STEP';
    fs.writeFileSync('package.json', JSON.stringify(data));
  `);
  await fs.writeFile(path.join(root, '.cevra-tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: [
    { id: 'build', profile: 'build', after: [] },
    { id: 'verify', profile: 'verify', after: ['build'] },
    { id: 'finish', profile: 'finish', after: ['verify'], continueOnFailure: true },
  ] }));
  const history = createFlightpathStore(path.join(folder, 'history')).forWorkspace(workspace);
  const runner = createTaskRunner(workspace, history);
  const { revision } = await readTaskCatalog(workspace);
  const { promise, resolve } = Promise.withResolvers();
  const events = [];
  const controller = await runner.start('dag:finish', revision, event => {
    events.push(event);
    if (event.type === 'exit') resolve(event);
  }, () => false);
  t.after(() => controller.stop());
  assert.equal((await promise).code, null);
  assert.deepEqual(events.filter(event => event.type === 'task-progress').map(event => [event.id, event.outcome]), [
    ['build', 'running'], ['build', 'passed'], ['verify', 'failed'], ['finish', 'blocked'],
  ]);
  assert.match(events.find(event => event.id === 'verify').reason, /changed/);
  assert.doesNotMatch(events.map(event => event.text ?? '').join(''), /ORIGINAL-STEP|CHANGED-STEP|FINAL-STEP/);
});

test('theme preferences default safely and persist concurrent changes in order', async t => {
  const folder = await temporaryFolder(t, 'cevra-theme-');
  const file = path.join(folder, 'preferences.json');
  assert.equal(await createPreferences(folder).getTheme(), 'dark');
  await fs.writeFile(file, '{ broken JSON');
  assert.equal(await createPreferences(folder).getTheme(), 'dark');
  assert.equal(await fs.readFile(file, 'utf8'), '{ broken JSON');

  await fs.writeFile(file, JSON.stringify({ theme: 'unknown', fontSize: 16 }));
  const preferences = createPreferences(folder);
  assert.equal(await preferences.getTheme(), 'dark');
  await assert.rejects(preferences.setTheme({ theme: 'light' }), /Choose Dark, Light, or System/);
  const light = preferences.setTheme('light');
  const system = preferences.setTheme('system');
  assert.deepEqual(await Promise.all([light, system, preferences.getTheme()]), ['light', 'system', 'system']);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { theme: 'system', fontSize: 16 });
  assert.equal(await createPreferences(folder).getTheme(), 'system');
});

test('a failed theme save keeps the committed preference and permits a later retry', async t => {
  const folder = await temporaryFolder(t, 'cevra-theme-');
  const file = path.join(folder, 'preferences.json');
  const preferences = createPreferences(folder);
  assert.equal(await preferences.getTheme(), 'dark');
  await fs.mkdir(file);
  await assert.rejects(preferences.setTheme('light'));
  assert.equal(await preferences.getTheme(), 'dark');
  assert.deepEqual(await fs.readdir(folder), ['preferences.json']);
  await fs.rmdir(file);
  assert.equal(await preferences.setTheme('light'), 'light');
  assert.equal(await createPreferences(folder).getTheme(), 'light');
});

test('editor settings inherit validated defaults and trust belongs to the original workspace directory', async t => {
  const { folder, root, workspace } = await fixture(t);
  const preferences = createPreferences(folder);
  await preferences.setEditor(workspace, 'global', { fontSize: 19, wrap: true, indentWidth: 4 });
  await preferences.setEditor(workspace, 'workspace', { indentWidth: 8, wrap: false });
  await assert.rejects(preferences.setEditor(workspace, 'workspace', { indentWidth: 0 }), /invalid/);
  await assert.rejects(preferences.setEditor(workspace, 'global', { fontFamily: 'arbitrary' }), /invalid/);
  assert.equal(await preferences.isTrusted(workspace), false);
  await preferences.setTrusted(workspace, true);
  const reopened = createPreferences(folder);
  assert.deepEqual((await reopened.getEditor(workspace)).overrides, { indentWidth: 8, wrap: false });
  assert.equal((await reopened.getEditor(workspace)).effective.fontSize, 19);
  assert.equal(await reopened.isTrusted(await createWorkspace(root)), true);
  await reopened.setEditor(workspace, 'workspace', null);
  assert.equal((await reopened.getEditor(workspace)).effective.indentWidth, 4);
  await fs.rename(root, path.join(folder, 'original'));
  await fs.mkdir(root);
  assert.equal(await reopened.isTrusted(await createWorkspace(root)), false);
});

test('workspace operations reject traversal, absolute paths, alternate streams, and hidden directories', async t => {
  const { folder, root, workspace } = await fixture(t);
  const outside = path.join(folder, 'outside.cjs');
  await fs.writeFile(outside, 'outside');
  await fs.writeFile(path.join(root, 'entry.cjs'), 'inside');
  const { revision } = await readSource(workspace, 'entry.cjs');

  const forbidden = ['../outside.cjs', outside, 'entry.cjs:alternate', '.git/config', 'node_modules/x.cjs'];
  if (process.platform === 'win32') forbidden.push('CON.cjs', 'NUL .cjs', 'entry.cjs.', 'entry.cjs ', '..\\outside.cjs');
  for (const relative of forbidden) {
    await assert.rejects(readSource(workspace, relative), /[Ww]orkspace path|outside the workspace/);
    await assert.rejects(saveSource(workspace, relative, 'modified', revision), /[Ww]orkspace path|outside the workspace/);
    await assert.rejects(listFolder(workspace, relative), /[Ww]orkspace path|outside the workspace/);
  }
  await assert.rejects(startNodeRun(workspace, '../outside.cjs', revision, () => {}), /outside the workspace/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  assert.equal(await fs.readFile(path.join(root, 'entry.cjs'), 'utf8'), 'inside');
});

test('workspace operations reject junctions, links, and replacement of the opened root', async t => {
  const { folder, root, workspace } = await fixture(t);
  const outside = path.join(folder, 'sibling');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'outside.cjs'), 'outside');
  await fs.writeFile(path.join(root, 'inside.cjs'), 'inside');
  const { revision } = await readSource(workspace, 'inside.cjs');
  await fs.symlink(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.link(path.join(outside, 'outside.cjs'), path.join(root, 'hard-link.cjs'));
  await assert.rejects(listFolder(workspace, 'outside-link'), /links cannot be opened/);
  for (const relative of [path.join('outside-link', 'outside.cjs'), 'hard-link.cjs']) {
    await assert.rejects(readSource(workspace, relative), /links cannot be opened/);
    await assert.rejects(saveSource(workspace, relative, 'modified', revision), /links cannot be opened/);
    await assert.rejects(startNodeRun(workspace, relative, revision, () => {}), /links cannot be opened/);
  }
  assert.equal(await fs.readFile(path.join(outside, 'outside.cjs'), 'utf8'), 'outside');

  await fs.rename(root, path.join(folder, 'original'));
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'inside.cjs'), 'inside');
  await assert.rejects(readSource(workspace, 'inside.cjs'), /workspace folder changed/);
  await assert.rejects(saveSource(workspace, 'inside.cjs', 'modified', revision), /workspace folder changed/);
  await assert.rejects(startNodeTests(workspace, path.join(folder, 'test-state.json'), () => {}), /workspace folder changed/);
  assert.equal(await fs.readFile(path.join(root, 'inside.cjs'), 'utf8'), 'inside');
});

test('saves atomically, serializes competing revisions, and preserves existing recovery copies', async t => {
  const { root, workspace } = await fixture(t);
  const file = path.join(root, 'draft.txt');
  await fs.writeFile(file, 'original');
  const { revision } = await readSource(workspace, 'draft.txt');
  const results = await Promise.allSettled([
    saveSource(workspace, 'draft.txt', 'first edit', revision),
    saveSource(workspace, 'draft.txt', 'second edit', revision),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /changed on disk/);
  assert.equal(await fs.readFile(file, 'utf8'), 'first edit');
  const first = await saveRecoveryCopy(workspace, 'draft.txt', 'recovered one');
  const second = await saveRecoveryCopy(workspace, 'draft.txt', 'recovered two');
  assert.notEqual(first, second);
  assert.equal(await fs.readFile(path.join(root, first), 'utf8'), 'recovered one');
  assert.equal(await fs.readFile(path.join(root, second), 'utf8'), 'recovered two');
  assert.equal(await fs.readFile(file, 'utf8'), 'first edit');
  assert.deepEqual((await fs.readdir(root)).sort(), [first, second, 'draft.txt'].sort());
});

test('an interrupted atomic write leaves the previous file intact and cleans up its temporary file', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'original.txt');
  await fs.writeFile(file, 'previous contents');
  await assert.rejects(writeAtomic(file, 'candidate contents', {
    beforeCommit() { throw new Error('simulated failed commit'); },
  }), /simulated failed commit/);
  assert.equal(await fs.readFile(file, 'utf8'), 'previous contents');
  assert.deepEqual(await fs.readdir(root), ['original.txt']);
});

test('rejects directories, invalid UTF-8, binary text, and oversized files without changing disk', async t => {
  const { root, workspace } = await fixture(t);
  await fs.mkdir(path.join(root, 'directory.cjs'));
  await fs.writeFile(path.join(root, 'encoding.txt'), Buffer.from([0xff]));
  await fs.writeFile(path.join(root, 'binary.txt'), Buffer.from([0]));
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 97));
  await fs.writeFile(path.join(root, 'normal.txt'), 'original');
  await assert.rejects(readSource(workspace, 'directory.cjs'), /regular file/);
  await assert.rejects(readSource(workspace, 'encoding.txt'), /UTF-8/);
  await assert.rejects(readSource(workspace, 'binary.txt'), /UTF-8/);
  await assert.rejects(readSource(workspace, 'large.txt'), /2 MB/);
  const { revision } = await readSource(workspace, 'normal.txt');
  await assert.rejects(saveSource(workspace, 'normal.txt', '\0', revision), /UTF-8/);
  await assert.rejects(saveSource(workspace, 'normal.txt', 'a'.repeat(2 * 1024 * 1024 + 1), revision), /2 MB/);
  assert.equal(await fs.readFile(path.join(root, 'normal.txt'), 'utf8'), 'original');
});

async function run(t, workspace, name) {
  const { revision } = await readSource(workspace, name);
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const output = [];
  const controller = await startNodeRun(workspace, name, revision, event => {
    if (event.type === 'output') output.push(event.text);
    if (event.type === 'exit') finish(event);
  });
  t.after(() => controller.stop());
  const exit = await completed;
  return { exit, output: output.join('') };
}

test('JavaScript runner delivers both streams, preserves exit status, and rejects stale source', { timeout: 10_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const name = 'run (# % &).cjs';
  const script = path.join(root, name);
  await fs.writeFile(script, 'if (require("node:fs").readFileSync(0).length) throw new Error("unexpected stdin");\n' +
    'console.log("stdout café"); console.error("stderr ✓"); process.exitCode = 37;\n');
  const { exit, output } = await run(t, workspace, name);
  assert.equal(exit.code, 37);
  assert.equal(exit.location, null);
  assert.match(output, /stdout café/);
  assert.match(output, /stderr ✓/);

  const { revision } = await readSource(workspace, name);
  await fs.writeFile(script, 'throw new Error("external code must not run");');
  await assert.rejects(startNodeRun(workspace, name, revision, () => assert.fail('stale source ran')), /changed on disk/);
});

test('JavaScript runner keeps syntax and cross-file runtime diagnostics after large stderr output', { timeout: 10_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const directory = 'nested (source) # %';
  const target = path.join(directory, 'error (detail).cjs');
  await fs.mkdir(path.join(root, directory));
  await fs.writeFile(path.join(root, target), 'module.exports = function fail() {\n  throw new Error("cross-file");\n};\n');
  await fs.writeFile(path.join(root, 'run.cjs'), [
    'process.stderr.write("x".repeat(220000) + "\\n");',
    'require(' + JSON.stringify('./' + target.split(path.sep).join('/')) + ')();',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'syntax.mjs'), 'const invalid = ;\n');
  const runtime = await run(t, workspace, 'run.cjs');
  assert.equal(runtime.exit.code, 1);
  assert.deepEqual(runtime.exit.location, { path: target, line: 2, column: 9 });
  assert.equal(runtime.exit.summary, 'Error: cross-file');
  const syntax = await run(t, workspace, 'syntax.mjs');
  assert.equal(syntax.exit.code, 1);
  assert.deepEqual(syntax.exit.location, { path: 'syntax.mjs', line: 1, column: 17 });
  assert.match(syntax.exit.summary, /SyntaxError/);
});

test('draft writes retain the last acknowledged edit and isolate damaged records', async t => {
  const { folder, root } = await fixture(t);
  const directory = path.join(folder, 'drafts');
  const store = createDraftStore(directory);
  const revision = 'a'.repeat(64);
  await Promise.all([
    store.set(root, 'one.txt', 'earlier', revision),
    store.set(root, 'one.txt', 'latest', revision),
    store.set(root, 'two.txt', 'independent', revision),
  ]);
  await fs.writeFile(path.join(directory, 'b'.repeat(64) + '.json'), '{incomplete');
  const reopened = createDraftStore(directory);
  const { entries, unreadable } = await reopened.list();
  assert.equal(unreadable, true);
  assert.deepEqual(Object.fromEntries(entries.map(draft => [draft.path, draft.text])), {
    'one.txt': 'latest',
    'two.txt': 'independent',
  });
  await reopened.set(root, 'one.txt', null);
  assert.deepEqual((await reopened.list()).entries.map(draft => draft.path), ['two.txt']);
});

test('a partially materialized edit journal restores every draft and replays before new writes', async t => {
  const { folder, root } = await fixture(t);
  const directory = path.join(folder, 'drafts');
  const store = createDraftStore(directory);
  const revision = 'c'.repeat(64);
  await store.set(root, 'one.js', 'partial materialization', revision);
  const batch = ['one.js', 'nested/café.js'].map(path => ({
    version: 1, root, path, text: 'committed batch ' + path, revision, updated: Date.now(),
  }));
  await fs.writeFile(path.join(directory, 'batch.json'), JSON.stringify(batch));
  const reopened = createDraftStore(directory);
  assert.deepEqual((await reopened.list()).entries, batch);
  await reopened.set(root, 'one.js', 'newer edit', revision);
  await assert.rejects(fs.access(path.join(directory, 'batch.json')), { code: 'ENOENT' });
  assert.deepEqual(Object.fromEntries((await createDraftStore(directory).list()).entries.map(draft => [draft.path, draft.text])), {
    'one.js': 'newer edit',
    'nested/café.js': 'committed batch nested/café.js',
  });
});

test('project search reads safe text and uses unsaved versions in place of disk copies', async t => {
  const { folder, root, workspace } = await fixture(t);
  const nested = 'nested (# % &)';
  const outside = path.join(folder, 'outside');
  for (const directory of [nested, 'node_modules', '.cache']) await fs.mkdir(path.join(root, directory));
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, nested, 'café.txt'), '\uFEFFskip\r\n  café [x+y]\r\n');
  await fs.writeFile(path.join(root, 'open.txt'), 'old [x+y]\n');
  await fs.writeFile(path.join(root, 'binary.txt'), Buffer.concat([Buffer.from('[x+y]'), Buffer.from([0])]));
  await fs.writeFile(path.join(root, 'node_modules', 'hidden.txt'), '[x+y]');
  await fs.writeFile(path.join(root, '.cache', 'hidden.txt'), '[x+y]');
  await fs.writeFile(path.join(outside, 'secret.txt'), '[x+y]');
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const { files, count, skipped } = await searchProject(workspace, '[x+y]', false, [
    { path: 'open.txt', documentId: 5, version: 8, text: 'updated [X+Y]\n' },
  ], new AbortController().signal);
  assert.equal(count, 2);
  assert.equal(skipped, 1);
  assert.deepEqual(files[0], {
    path: 'open.txt', documentId: 5, version: 8,
    matches: [{ line: 1, column: 9, length: 5, preview: 'updated [X+Y]' }],
  });
  assert.equal(files[1].path, path.join(nested, 'café.txt'));
  assert.match(files[1].revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(files[1].matches, [{ line: 2, column: 8, length: 5, preview: '  café [x+y]' }]);
  assert.equal((await searchProject(workspace, '[X+Y]', true, [], new AbortController().signal)).count, 0);
});

test('project search caps results, handles cancellation, and rejects an unsafe draft path', async t => {
  const { root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'many.txt'), 'token\n'.repeat(600));
  const result = await searchProject(workspace, 'token', false, [], new AbortController().signal);
  assert.equal(result.count, 400);
  assert.equal(result.limited, true);
  assert.equal(result.files[0].matches.at(-1).line, 400);

  const search = new AbortController();
  const pending = searchProject(workspace, 'token', false, [], search.signal);
  setImmediate(() => search.abort());
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(searchProject(workspace, 'token', false, [
    { path: '../outside.txt', documentId: 1, version: 0, text: 'token' },
  ], new AbortController().signal), /outside the workspace/);
});

test('syntax checks locate JavaScript and TypeScript errors and handle EOF and JSX', { timeout: 15_000 }, async t => {
  const syntax = createSyntaxService();
  t.after(syntax.stop);
  const js = 'const broken = ;\n';
  const [broken, typed, valid, eof, jsx] = await Promise.all([
    syntax.analyze('nested (# %)/entry.cjs', js),
    syntax.analyze('typed.js', 'const count: number = 1;\n'),
    syntax.analyze('valid.mts', 'import "./unavailable";\nconst count: number = 1;\nthrow new Error("never run");'),
    syntax.analyze('unclosed.ts', 'export function read() {\n'),
    syntax.analyze('view.tsx', 'const view = <button>Close</span>;\n'),
  ]);
  assert.deepEqual(broken.issues, [{
    from: 15, to: 16, line: 1, column: 16, severity: 'error', code: 1109, message: 'Expression expected.',
  }]);
  assert.equal(js.slice(broken.issues[0].from, broken.issues[0].to), ';');
  assert.equal(typed.issues[0].code, 8010);
  assert.deepEqual(valid.issues, []);
  assert.equal(eof.issues[0].line, 2);
  assert.equal(eof.issues[0].column, 1);
  assert.equal(eof.issues[0].from, eof.issues[0].to);
  assert.match(jsx.issues[0].message, /closing tag/);
});

test('syntax checks bound source size and displayed diagnostics', { timeout: 15_000 }, async t => {
  const syntax = createSyntaxService();
  t.after(syntax.stop);
  const many = await syntax.analyze('many.js', 'const broken = ;\n'.repeat(125));
  assert.equal(many.issues.length, 100);
  assert.equal(many.omitted, 25);
  await assert.rejects(syntax.analyze('note.txt', 'const broken = ;'), /JavaScript or TypeScript/);
  await assert.rejects(syntax.analyze('large.ts', 'a'.repeat(2 * 1024 * 1024 + 1)), /2 MB/);
});

test('syntax worker exits reject outstanding checks and a later request starts a replacement', { timeout: 15_000 }, async t => {
  const { folder } = await fixture(t);
  const worker = path.join(folder, 'worker.cjs');
  await fs.writeFile(worker, [
    'const { parentPort } = require("node:worker_threads");',
    'parentPort.on("message", ({ id, text }) => {',
    '  if (text === "exit") process.exit(23);',
    '  parentPort.postMessage({ id, result: { issues: [], omitted: 0 } });',
    '});',
  ].join('\n'));
  const syntax = createSyntaxService(worker);
  t.after(syntax.stop);
  const settled = await Promise.allSettled([
    syntax.analyze('first.js', 'exit'),
    syntax.analyze('second.ts', 'pending'),
  ]);
  for (const check of settled) {
    assert.equal(check.status, 'rejected');
    assert.match(check.reason.message, /analyzer stopped/);
  }
  assert.deepEqual(await syntax.analyze('second.ts', 'valid'), { issues: [], omitted: 0 });
});

function applyFormat(source, changes) {
  for (const { from, to, insert } of [...changes].reverse()) {
    source = source.slice(0, from) + insert + source.slice(to);
  }
  return source;
}

test('the CEVRA formatter edits whitespace, preserves literal content and ASI, and is idempotent', { timeout: 15_000 }, async t => {
  const { workspace } = await fixture(t);
  const formatter = createFormatService();
  t.after(formatter.stop);
  const template = 'const raw=' + String.fromCharCode(96) + 'a  ' + '$' + '{1+  2}' + String.fromCharCode(96) + ';';
  const source = [
    '#!/usr/bin/env node',
    'const text="  a  ";const pattern=/a  b/;',
    template,
    'function run(n){',
    '// preserve spacing  here',
    'return',
    '{ value:n+1 }',
    '}',
    'const property=1 .toString();',
    'const double=a+ +b;',
  ].join('\n');
  const { changes, eol } = await formatter.format(workspace, 'entry.cjs', source, '\r\n');
  for (const { from, to, insert } of changes) {
    assert.match(source.slice(from, to), /^\s*$/);
    assert.match(insert, /^\s*$/);
  }
  const formatted = applyFormat(source, changes);
  assert.match(formatted, /^#!\/usr\/bin\/env node\nconst text = "  a  ";\nconst pattern = \/a  b\/;/);
  assert.ok(formatted.includes(template.replace('raw=', 'raw = ')));
  assert.match(formatted, /function run\(n\) \{\n  \/\/ preserve spacing  here\n  return\n  \{\n    value: n \+ 1\n  \}\n\}/);
  assert.match(formatted, /const property = 1 \.toString\(\);\nconst double = a \+ \+b;\n$/);
  assert.equal(eol, '\r\n');
  assert.deepEqual(await formatter.format(workspace, 'entry.cjs', formatted, eol), { changes: [], eol });

  const jsx = 'const view=<main>exact  text {a+  b}</main>;';
  assert.equal(applyFormat(jsx, (await formatter.format(workspace, 'view.tsx', jsx, '\n')).changes),
    'const view = <main>exact  text {a+  b}</main>;\n');
});

test('formatting uses the nearest scoped CEVRA settings and rejects unsafe or invalid inputs', { timeout: 15_000 }, async t => {
  const { folder, root, workspace } = await fixture(t);
  const formatter = createFormatService();
  t.after(formatter.stop);
  const nested = 'nested (# % &)';
  await fs.mkdir(path.join(root, nested));
  await fs.writeFile(path.join(root, '.cevra-format.json'), '{"indentWidth":4}');
  await fs.writeFile(path.join(root, nested, '.cevra-format.json'),
    '{"indentStyle":"tabs","bracketSpacing":false,"finalNewline":false,"lineEnding":"crlf"}');
  const source = 'export function next(a:number){return {a:a+1}}';
  const outer = await formatter.format(workspace, 'plain.ts', source, '\n');
  assert.equal(applyFormat(source, outer.changes), 'export function next(a: number) {\n    return { a: a + 1 }\n}\n');
  assert.equal(outer.eol, '\n');
  const inner = await formatter.format(workspace, path.join(nested, 'next.ts'), source, '\n');
  assert.equal(applyFormat(source, inner.changes), 'export function next(a: number) {\n\treturn {a: a + 1}\n}');
  assert.equal(inner.eol, '\r\n');
  await assert.rejects(formatter.format(workspace, 'broken.js', 'const x = ;', '\n'), /Fix the syntax error first/);
  await assert.rejects(formatter.format(workspace, '../outside.js', source, '\n'), /outside the workspace/);
  await fs.writeFile(path.join(root, nested, '.cevra-format.json'), '{"indentWidth":-1}');
  await assert.rejects(formatter.format(workspace, path.join(nested, 'next.ts'), source, '\n'), /invalid formatting option/);

  const outside = path.join(folder, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, '.cevra-format.json'), '{"indentWidth":8}');
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(formatter.format(workspace, 'linked/source.ts', source, '\n'), /Workspace links cannot be opened/);
});

test('semantic queries follow project aliases and prefer unsaved versions across files', { timeout: 20_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const folder = 'lib (# % &)';
  const helper = path.join(folder, 'price.ts');
  const importer = 'main.ts';
  await fs.mkdir(path.join(root, folder));
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { paths: { '@lib/*': ['./' + folder + '/*'] } },
  }));
  const saved = '/** From disk. */\nexport function price(amount: number): string { return String(amount); }\n';
  await fs.writeFile(path.join(root, helper), saved);
  const text = 'import { price } from "@lib/price";\nconst result = price(12);\n';
  const main = { path: importer, documentId: 1, version: 0, text };
  const position = text.lastIndexOf('price(') + 2;
  const disk = await semantics.quickInfo(workspace, importer, position, [main]);
  assert.match(disk.signature, /price\(amount: number\): string/);
  assert.match(disk.documentation, /From disk/);
  assert.equal(text.slice(disk.from, disk.to), 'price');
  const draft = {
    path: helper, documentId: 2, version: 1,
    text: '/** From the unsaved editor. */\nexport function price(amount: bigint, currency: string): string { return currency + amount; }\n',
  };
  const updated = await semantics.quickInfo(workspace, importer, position, [main, draft]);
  assert.match(updated.signature, /price\(amount: bigint, currency: string\): string/);
  assert.match(updated.documentation, /From the unsaved editor/);
  assert.equal(await fs.readFile(path.join(root, helper), 'utf8'), saved);

  await fs.writeFile(path.join(root, helper), 'export function price(amount: boolean): boolean { return amount; }\n');
  const refreshed = await semantics.quickInfo(workspace, importer, position, [main]);
  assert.match(refreshed.signature, /price\(amount: boolean\): boolean/);

  await fs.unlink(path.join(root, helper));
  await fs.rmdir(path.join(root, folder));
  const recovered = await semantics.quickInfo(workspace, importer, position, [main, draft]);
  assert.match(recovered.signature, /price\(amount: bigint, currency: string\): string/);
});

test('semantic queries check JavaScript and confine module reads to permitted workspace files', { timeout: 20_000 }, async t => {
  const { folder, root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const outside = path.join(folder, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.js'), 'export function reveal() { return "outside private"; }\n');
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'hidden.js'), 'export function reveal() { return "dependency private"; }\n');
  await fs.writeFile(path.join(root, 'greet.js'),
    '/** @param {string} name */\nexport function greet(name) { return "Hello " + name; }\n');
  const valid = 'import { greet } from "./greet.js";\ngreet("World");\n';
  const source = { path: 'index.js', documentId: 1, version: 0, text: valid };
  const info = await semantics.quickInfo(workspace, source.path, valid.lastIndexOf('greet('), [source]);
  assert.match(info.signature, /greet\(name: string\): string/);
  for (const [index, module] of ['../outside/secret.js', './linked/secret.js', './node_modules/hidden.js'].entries()) {
    const text = 'import { reveal } from ' + JSON.stringify(module) + ';\nreveal();\n';
    const inaccessible = await semantics.quickInfo(workspace, source.path, text.lastIndexOf('reveal('),
      [{ ...source, version: index + 1, text }]);
    assert.equal(inaccessible, null);
  }
  await assert.rejects(semantics.quickInfo(workspace, source.path, 0, [
    source, { path: '../outside/secret.js', documentId: 2, version: 0, text: valid },
  ]), /outside the workspace/);
  const config = path.join(root, 'jsconfig.json');
  await fs.writeFile(config, '{"compilerOptions":');
  await assert.rejects(semantics.quickInfo(workspace, source.path, valid.lastIndexOf('greet('), [source]),
    /Check the JSON in jsconfig\.json/);
  await fs.writeFile(config, '{}');
  const restored = await semantics.quickInfo(workspace, source.path, valid.lastIndexOf('greet('), [source]);
  assert.match(restored.signature, /greet\(name: string\): string/);

  await fs.writeFile(path.join(root, 'greet.cjs'),
    '/** @param {string} name */\nfunction greet(name) { return "Hello " + name; }\nmodule.exports = { greet };\n');
  const commonJS = 'const { greet } = require("./greet.cjs");\nconst names = ["world"];\nnames.map(greet);\ngreet("world");\n';
  const script = { path: 'index.cjs', documentId: 2, version: 0, text: commonJS };
  const call = await semantics.quickInfo(workspace, script.path, commonJS.lastIndexOf('greet('), [script]);
  assert.match(call.signature, /greet\(name: string\): string/);
  const arrayMethod = await semantics.quickInfo(workspace, script.path, commonJS.indexOf('map('), [script]);
  assert.match(arrayMethod.signature, /Array<string>\.map/);
});

test('type diagnostics respect JavaScript opt-in, leading pragmas, and the workspace compiler options', async t => {
  const { root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const body = '/** @type {number} */\nconst count = "three";\n';
  const check = (text, file = 'types.js') => semantics.diagnostics(workspace, file, [
    { path: file, documentId: 1, version: 0, text },
  ]);
  assert.equal((await check(body)).enabled, false);
  assert.equal((await check(body + 'const marker = `\n// @ts-check\n`;')).enabled, false);
  assert.deepEqual((await check('// @ts-check\n' + body)).issues.map(issue => issue.source), ['TS2322']);
  await fs.writeFile(path.join(root, 'jsconfig.json'), '{"compilerOptions":{"checkJs":true}}');
  assert.deepEqual((await check(body)).issues.map(issue => issue.source), ['TS2322']);
  assert.equal((await check('// @ts-nocheck\n' + body)).directive, 'nocheck');
  assert.equal((await check('// @ts-nocheck\nconst bad: number = "three";', 'types.ts')).enabled, false);
});

test('completions use unsaved imports and preserve exact TypeScript replacement ranges', { timeout: 20_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const saved = 'export const data = { diskOnly: 1 };\n';
  await fs.writeFile(path.join(root, 'data.ts'), saved);
  const draft = {
    path: 'data.ts', documentId: 2, version: 1,
    text: 'export const data = { calculate() {}, "dash-name": 1 };\nexport function makeMode() {}\n',
  };
  let version = 0;
  async function suggest(marked, overlays = []) {
    const position = marked.lastIndexOf('|');
    const text = marked.slice(0, position) + marked.slice(position + 1);
    return semantics.complete(workspace, 'main.ts', position, [
      { path: 'main.ts', documentId: 1, version: version++, text }, ...overlays,
    ]);
  }
  const imports = 'import { data } from "./data";\n';
  const before = await suggest(imports + 'data.|');
  assert.deepEqual(before.options.map(item => item.label), ['diskOnly']);
  const after = await suggest(imports + 'data.|', [draft]);
  assert.deepEqual(after.options.map(({ label, kind }) => [label, kind]), [
    ['calculate', 'method'], ['dash-name', 'property'],
  ]);

  const existing = imports + 'data.calOld;';
  const middle = await suggest(imports + 'data.cal|Old;', [draft]);
  const [method] = middle.options;
  assert.equal(middle.options.length, 1);
  assert.equal(existing.slice(method.from, method.to), 'calOld');
  assert.equal(method.insert, 'calculate');

  const optional = imports + 'data?.da;';
  const bracket = await suggest(imports + 'data?.da|;', [draft]);
  const [property] = bracket.options;
  assert.equal(optional.slice(property.from, property.to), '?.da');
  assert.equal(property.insert, '?.["dash-name"]');

  const named = await suggest('import { make| } from "./data";', [draft]);
  assert.deepEqual(named.options.map(item => item.label), ['makeMode']);
  const argument = await suggest('function set(level: "basic" | "advanced") {}\nset("ba|");');
  assert.deepEqual(argument?.options.map(item => item.label), ['basic']);
  assert.equal(await fs.readFile(path.join(root, 'data.ts'), 'utf8'), saved);
});

test('completion results are bounded, ranked before truncation, and confined to the workspace', { timeout: 20_000 }, async t => {
  const { folder, root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  await fs.writeFile(path.join(folder, 'outside.js'), 'export const value = { privateData: 1 };\n');
  await fs.writeFile(path.join(root, 'unimported.ts'), 'export const workspaceAutoImport = 1;\n');
  const keys = Array.from({ length: 100 }, (_, index) => 'alpha' + index + ': 0');
  const text = 'const value = { ' + keys.join(', ') + ', zebra: 1 };\nvalue.';
  const source = { path: 'index.js', documentId: 1, version: 0, text };
  const limited = await semantics.complete(workspace, source.path, text.length, [source]);
  assert.equal(limited.options.length, 80);
  const narrowed = await semantics.complete(workspace, source.path, text.length + 1, [
    { ...source, version: 1, text: text + 'z' },
  ]);
  assert.deepEqual(narrowed.options.map(item => item.label), ['zebra']);
  for (const [index, input] of [
    'import { value } from "../outside.js";\nvalue.',
    'workspaceAutoIm',
    'const label = "workspaceAutoIm',
  ].entries()) {
    const result = await semantics.complete(workspace, source.path, input.length, [
      { ...source, version: index + 2, text: input },
    ]);
    assert.equal(result?.options.length ?? 0, 0);
  }
});

test('completion bursts keep the newest queued request and cancel queued work on shutdown', { timeout: 20_000 }, async t => {
  const { workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  function suggest(label, version) {
    const text = `const value = { ${label}: 1 };\nvalue.`;
    return semantics.complete(workspace, 'main.ts', text.length, [
      { path: 'main.ts', documentId: 1, version, text },
    ]);
  }

  const [first, replaced, latest] = await Promise.all([suggest('first', 0), suggest('replaced', 1), suggest('latest', 2)]);
  assert.deepEqual(first.options.map(item => item.label), ['first']);
  assert.equal(replaced, null);
  assert.deepEqual(latest.options.map(item => item.label), ['latest']);

  const canceled = assert.rejects(suggest('inFlight', 3), /language request was canceled/);
  const queued = suggest('queued', 4);
  semantics.stop();
  await canceled;
  assert.equal(await queued, null);
  const restarted = await suggest('restarted', 5);
  assert.deepEqual(restarted.options.map(item => item.label), ['restarted']);
});

test('signature help uses parameter documentation from unsaved JavaScript imports', { timeout: 20_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const saved = '/**\n * @param {number} amount Price amount.\n * @param {string} unit Saved unit.\n */\n' +
    'export function price(amount, unit) { return amount + unit; }\n';
  await fs.writeFile(path.join(root, 'price.js'), saved);
  const text = 'import { price } from "./price.js";\nprice(12, );';
  const source = { path: 'main.js', documentId: 1, version: 0, text };
  const position = text.lastIndexOf(')');
  const disk = await semantics.signatureHelp(workspace, source.path, position, [source]);
  assert.equal(disk.before, 'price(amount: number, ');
  assert.equal(disk.parameter, 'unit: string');
  assert.equal(disk.after, '): string');
  assert.equal(disk.documentation, 'Saved unit.');

  const draft = {
    path: 'price.js', documentId: 2, version: 1,
    text: saved.replaceAll('unit', 'currency').replace('Saved currency.', 'Draft currency.'),
  };
  const unsaved = await semantics.signatureHelp(workspace, source.path, position, [source, draft]);
  assert.equal(unsaved.parameter, 'currency: string');
  assert.equal(unsaved.documentation, 'Draft currency.');
  assert.equal(await fs.readFile(path.join(root, 'price.js'), 'utf8'), saved);
  assert.equal(await semantics.signatureHelp(workspace, source.path, position + 1, [source]), null);
});

test('signature help follows nested calls, selects overloads, and handles rest and missing parameters',
  { timeout: 20_000 }, async t => {
  const { workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const declarations = 'function outer(count: number, label: string) {}\n' +
    'function inner(text: string): number { return text.length; }\n' +
    'function over(value: number, flag: boolean): void;\n' +
    'function over(value: string, name: string): void;\n' +
    'function over(value: unknown, second: unknown) {}\n' +
    'function sum(label: string, ...values: number[]) {}\n' +
    'function none() {}\n';
  let version = 0;
  function help(marked) {
    const text = declarations + marked.replace('|', '');
    return semantics.signatureHelp(workspace, 'calls.ts', declarations.length + marked.indexOf('|'), [
      { path: 'calls.ts', documentId: 1, version: version++, text },
    ]);
  }
  const inner = await help('outer(inner(|), "x");');
  assert.equal(inner.before, 'inner(');
  assert.equal(inner.parameter, 'text: string');
  const outer = await help('outer(inner("x"), |);');
  assert.equal(outer.before, 'outer(count: number, ');
  assert.equal(outer.parameter, 'label: string');
  const first = await help('over(1, |);');
  assert.deepEqual([first.overload, first.overloadCount, first.parameter], [1, 2, 'flag: boolean']);
  const second = await help('over("x", |);');
  assert.deepEqual([second.overload, second.overloadCount, second.parameter], [2, 2, 'name: string']);
  assert.equal((await help('sum("x", 1, 2, |);')).parameter, '...values: number[]');
  assert.equal((await help('none(|);')).parameter, '');
  assert.equal((await help('inner("x", |);')).parameter, '');
  assert.equal(await help('missing(|);'), null);
});

test('signature help and autocomplete keep separate latest requests during a typing burst',
  { timeout: 20_000 }, async t => {
  const { workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  function complete(label, version) {
    const text = `const value = { ${label}: 1 };\nvalue.`;
    return semantics.complete(workspace, 'object.ts', text.length, [
      { path: 'object.ts', documentId: 1, version, text },
    ]);
  }
  function help(parameter, version) {
    const text = `function call(${parameter}: number) {}\ncall()`;
    return semantics.signatureHelp(workspace, 'call.ts', text.length - 1, [
      { path: 'call.ts', documentId: 2, version, text },
    ]);
  }
  const results = await Promise.all([
    complete('first', 0), help('discarded', 0), complete('discarded', 1), help('current', 1), complete('current', 2),
  ]);
  assert.equal(results[0].options[0].label, 'first');
  assert.equal(results[1], null);
  assert.equal(results[2], null);
  assert.equal(results[3].parameter, 'current: number');
  assert.equal(results[4].options[0].label, 'current');
});

test('definition lookup follows aliases and re-exports with exact disk and draft coordinates',
  { timeout: 20_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const folder = 'nested (QA) # % & café';
  const definition = path.join(folder, 'math.ts');
  const saved = '\uFEFF// BOM and Windows line endings\r\nexport function total(input: number) { return input; }\r\n';
  await fs.mkdir(path.join(root, folder));
  await fs.writeFile(path.join(root, definition), saved);
  await fs.writeFile(path.join(root, 'barrel.ts'), 'export { total as sum } from "./' + folder + '/math";');
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@math': ['./barrel'] } } }));
  const text = 'import { sum as calculate } from "@math";\ncalculate(2);';
  const source = { path: 'main.ts', documentId: 1, version: 0, text };
  const position = text.lastIndexOf('calculate') + 3;
  const disk = await semantics.definition(workspace, source.path, position, [source]);
  const { revision } = await readSource(workspace, definition);
  const normalized = saved.slice(1).replaceAll('\r\n', '\n');
  assert.deepEqual(disk, { limited: false, destinations: [{
    path: definition, offset: normalized.indexOf('total'), length: 5, line: 2, column: 17, name: 'total', revision,
  }] });

  const draft = { path: definition, documentId: 2, version: 3, text: '// draft\n\n' + normalized };
  const updated = await semantics.definition(workspace, source.path, position, [source, draft]);
  assert.deepEqual(updated.destinations, [{
    path: definition, offset: draft.text.indexOf('total'), length: 5, line: 4, column: 17, name: 'total',
    documentId: 2, version: 3,
  }]);
  assert.equal(await fs.readFile(path.join(root, definition), 'utf8'), saved);

  const script = path.join(folder, 'math.cjs');
  const module = 'function total(value) { return value; }\nmodule.exports = { total };\n';
  await fs.writeFile(path.join(root, script), module);
  const call = 'const { total } = require("./' + folder + '/math.cjs");\ntotal(4);';
  const commonJS = { path: 'main.cjs', documentId: 3, version: 0, text: call };
  const js = await semantics.definition(workspace, commonJS.path, call.lastIndexOf('total') + 2, [commonJS]);
  assert.deepEqual(js.destinations.map(({ path, offset, length }) => [path, offset, length]), [[script, 9, 5]]);
});

test('definition lookup returns distinct choices and rejects unresolved or non-workspace destinations',
  { timeout: 20_000 }, async t => {
  const { folder, root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const outside = path.join(folder, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.js'), 'export const hidden = 1;');
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'hidden.js'), 'export const hidden = 2;');
  let version = 0;
  function lookup(marked) {
    const text = marked.replace('|', '');
    return semantics.definition(workspace, 'main.ts', marked.indexOf('|'), [
      { path: 'main.ts', documentId: 1, version: version++, text },
    ]);
  }
  const interfaces = Array.from({ length: 42 }, (_, index) => `interface Shape { field${index}: number }`);
  const multiple = await lookup(interfaces.join('\n') + '\nlet value: Sh|ape;');
  assert.equal(multiple.limited, true);
  assert.equal(multiple.destinations.length, 40);
  assert.equal(new Set(multiple.destinations.map(target => target.offset)).size, 40);
  assert.ok(multiple.destinations.every(target => target.path === 'main.ts' && target.documentId === 1 && target.version === 0));
  for (const marked of [
    '[1].ma|p(value => value);',
    'import { hidden } from "./missing.js";\nhi|dden;',
    'import { hidden } from "../outside/private.js";\nhi|dden;',
    'import { hidden } from "./linked/private.js";\nhi|dden;',
    'import { hidden } from "./node_modules/hidden.js";\nhi|dden;',
  ]) {
    assert.deepEqual(await lookup(marked), { destinations: [], limited: false });
  }
});

test('reference search follows renamed imports into closed files and uses open drafts', { timeout: 20_000 }, async t => {
  const { folder, root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const nested = 'lib (QA) # % & café';
  for (const directory of [nested, 'separate', '.cache', 'node_modules']) await fs.mkdir(path.join(root, directory));
  const declaration = path.join(nested, 'math.ts');
  const original = '\uFEFF// Saved declaration\r\nexport function total(value: number) { return value; }\r\n';
  const closed = path.join(nested, 'consumer.js');
  const closedText = 'import { price as closedCall } from "@prices";\nclosedCall(8);\n// closedCall(9);\n';
  const savedDraft = 'import { price as oldCall } from "@prices";\noldCall(1);\n';
  const outside = path.join(folder, 'outside');
  await fs.mkdir(outside);
  await Promise.all([
    fs.writeFile(path.join(root, declaration), original),
    fs.writeFile(path.join(root, closed), closedText),
    fs.writeFile(path.join(root, 'barrel.ts'), 'export { total as price } from "./' + nested + '/math";'),
    fs.writeFile(path.join(root, 'draft.ts'), savedDraft),
    fs.writeFile(path.join(root, 'unrelated.ts'), 'export function total() {}\ntotal();'),
    fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@prices': ['./barrel'] } } })),
    fs.writeFile(path.join(root, 'separate', 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@prices': ['./own'] } } })),
    fs.writeFile(path.join(root, 'separate', 'own.ts'), 'export const price = () => 1;'),
    fs.writeFile(path.join(root, 'separate', 'consumer.ts'), closedText),
    fs.writeFile(path.join(root, '.cache', 'ignored.ts'), closedText),
    fs.writeFile(path.join(root, 'node_modules', 'ignored.js'), closedText),
    fs.writeFile(path.join(outside, 'outside.js'), closedText),
  ]);
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const text = 'import { price as local } from "@prices";\nlocal(2);';
  const source = { path: 'main.ts', documentId: 1, version: 0, text };
  const draft = {
    path: 'draft.ts', documentId: 2, version: 4,
    text: '\nimport { price as freshCall } from "@prices";\nfreshCall(3);\n',
  };
  const result = await semantics.references(workspace, source.path, text.lastIndexOf('local') + 2, [source, draft], 1);
  const files = new Map(result.files.map(file => [file.path, file]));
  assert.deepEqual([...files.keys()].sort(), [declaration, closed, 'barrel.ts', 'draft.ts', 'main.ts'].sort());
  assert.equal(result.scope, '.');
  assert.equal(result.separateProjects, 1);
  assert.equal(result.scopeLimited, false);
  assert.equal(result.resultLimited, false);
  assert.equal(files.get(declaration).revision, (await readSource(workspace, declaration)).revision);
  assert.deepEqual(files.get(declaration).matches.map(({ line, column, declaration }) => [line, column, declaration]), [[2, 17, true]]);
  const closedUse = files.get(closed).matches.find(match => match.line === 2);
  assert.equal(closedText.slice(closedUse.offset, closedUse.offset + closedUse.length), 'closedCall');
  assert.equal(files.get(closed).matches.some(match => match.line === 3), false);
  assert.equal(files.get('draft.ts').documentId, 2);
  assert.equal(files.get('draft.ts').version, 4);
  assert.ok(files.get('draft.ts').matches.some(match => match.line === 3 && match.preview === 'freshCall(3);'));
  assert.equal(await fs.readFile(path.join(root, 'draft.ts'), 'utf8'), savedDraft);
});

test('reference search follows verified CommonJS bindings and property calls from both ends',
  { timeout: 20_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const files = {
    'lib.cjs': 'function greet(name) { return name; }\nmodule.exports = { greet };',
    'consumer.cjs': 'const { greet: speak } = require("./lib.cjs");\nspeak("caller");\nfunction unrelated(speak) { speak(); }',
    'properties.cjs': 'const lib = require("./lib.cjs");\nlib.greet("first");\nlib["greet"]("second");',
    'other.cjs': 'function greet() {}\nmodule.exports = { greet };',
    'unrelated.cjs': 'const { greet: speak } = require("./other.cjs");\nspeak("unrelated");',
  };
  await Promise.all(Object.entries(files).map(([file, text]) => fs.writeFile(path.join(root, file), text)));
  for (const [id, file, token] of [[1, 'lib.cjs', 'greet'], [2, 'consumer.cjs', 'speak("caller")']]) {
    const text = files[file];
    const result = await semantics.references(workspace, file, text.indexOf(token) + 2, [
      { path: file, documentId: id, version: 0, text },
    ], id);
    const groups = new Map(result.files.map(group => [group.path, group.matches]));
    assert.deepEqual([...groups.keys()].sort(), ['consumer.cjs', 'lib.cjs', 'properties.cjs']);
    assert.deepEqual(groups.get('consumer.cjs').filter(match => match.line > 1).map(match => match.line), [2]);
    const properties = groups.get('properties.cjs').map(match => [
      match.line, files['properties.cjs'].slice(match.offset, match.offset + match.length),
    ]);
    assert.deepEqual(properties, [[2, 'greet'], [3, 'greet']]);
  }
});

test('reference search reports bounded file discovery and results', { timeout: 20_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  await Promise.all(Array.from({ length: 256 }, (_, index) => fs.writeFile(path.join(root, `empty-${index}.js`), 'export {};')));
  const text = 'const target = 1;\n' + 'target;\n'.repeat(410);
  const source = { path: 'main.ts', documentId: 1, version: 0, text };
  const result = await semantics.references(workspace, source.path, text.indexOf('target') + 2, [source], 1);
  assert.equal(result.scopeLimited, true);
  assert.equal(result.resultLimited, true);
  assert.equal(result.count, 400);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].matches.length, 400);
});

test('canceling references stops only the matching search and leaves other language requests available',
  { timeout: 20_000 }, async t => {
  const { workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const text = 'const value = 1;\nvalue;';
  const source = { path: 'main.ts', documentId: 1, version: 0, text };
  const position = text.lastIndexOf('value') + 2;
  const stopped = assert.rejects(semantics.references(workspace, source.path, position, [source], 1), /reference search was canceled/);
  semantics.cancelReferences(workspace, 1);
  await stopped;
  const newer = semantics.references(workspace, source.path, position, [source], 2);
  semantics.cancelReferences(workspace, 1);
  const [result, info] = await Promise.all([newer, semantics.quickInfo(workspace, source.path, position, [source])]);
  assert.equal(result.count, 2);
  assert.match(info.signature, /const value/);
});

test('workspace symbol search finds named declarations in closed files and replaces disk symbols with drafts',
  { timeout: 20_000 }, async t => {
  const { folder, root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const nested = 'package (QA) # % & café';
  const file = path.join(nested, 'shipping.ts');
  const saved = '\uFEFF// Windows source\r\nexport class Shipment {\r\n  track() { return 1; }\r\n}\r\n';
  await fs.mkdir(path.join(root, nested));
  await fs.mkdir(path.join(root, '.cache'));
  const outside = path.join(folder, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await Promise.all([
    fs.writeFile(path.join(root, nested, 'tsconfig.json'), '{}'),
    fs.writeFile(path.join(root, file), saved),
    fs.writeFile(path.join(root, 'other.js'), 'export function track() {}\nimport { track as trackAlias } from "./shipping";'),
    fs.writeFile(path.join(root, '.cache', 'hidden.ts'), 'export function track() {}'),
    fs.writeFile(path.join(outside, 'linked.ts'), 'export function track() {}'),
  ]);
  const disk = await semantics.symbols(workspace, 'track', [], 1);
  assert.deepEqual(disk.items.map(({ name, kind, container, path }) => [name, kind, container, path]), [
    ['track', 'function', '', 'other.js'], ['track', 'method', 'Shipment', file],
  ]);
  const method = disk.items[1];
  assert.equal(method.offset, saved.slice(1).replaceAll('\r\n', '\n').indexOf('track'));
  assert.equal(method.line, 3);
  assert.equal(method.column, 3);
  assert.equal(method.revision, (await readSource(workspace, file)).revision);
  const drafts = [{ path: file, documentId: 7, version: 3, text: 'export type DraftTrack = string;\n' }];
  const updated = await semantics.symbols(workspace, 'track', drafts, 2);
  assert.deepEqual(updated.items.map(({ name }) => name), ['track', 'DraftTrack']);
  assert.deepEqual(updated.items[1], {
    name: 'DraftTrack', kind: 'type', container: '', path: file, offset: 12, length: 10, line: 1, column: 13,
    documentId: 7, version: 3,
  });
  assert.equal(await fs.readFile(path.join(root, file), 'utf8'), saved);
  await fs.writeFile(path.join(root, 'other.js'), 'export function refreshedTrack() {}');
  const refreshed = await semantics.symbols(workspace, 'refreshed', drafts, 3);
  assert.deepEqual(refreshed.items.map(({ name }) => name), ['refreshedTrack']);
  await assert.rejects(semantics.symbols(workspace, 'track', [{ ...drafts[0], path: '../outside/linked.ts' }], 4),
    /outside the workspace/);
});

test('workspace symbol search bounds results and cancels only the matching request', { timeout: 20_000 }, async t => {
  const { workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const text = Array.from({ length: 100 }, (_, index) => `export const named${index} = ${index};`).join('\n');
  const drafts = [{ path: 'unsaved.ts', documentId: 1, version: 0, text }];
  const stopped = assert.rejects(semantics.symbols(workspace, 'named', drafts, 1), /symbol search was canceled/);
  semantics.cancelSymbols(workspace, 1);
  await stopped;
  const current = semantics.symbols(workspace, 'named', drafts, 2);
  semantics.cancelSymbols(workspace, 1);
  const result = await current;
  assert.equal(result.items.length, 80);
  assert.equal(result.more, true);
  const exact = await semantics.symbols(workspace, 'named9', drafts, 3);
  assert.equal(exact.items[0].name, 'named9');
});
