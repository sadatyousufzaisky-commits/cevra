const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { assertWindowsProcessStopped, openWorkbench, replaceEditor } = require('./desktop-workbench.cjs');

const execute = promisify(execFile);
const windows = process.platform === 'win32';
const goal = 'Repair calculation regression';
const folder = 'invoice (QA) & café';
const filename = 'total # %.cjs';
const source = folder + '/' + filename;
const broken = [
  'module.exports = function invoiceTotal(subtotal, fee) {',
  '  const total = subtotal - fee;',
  '  if (total < subtotal) {',
  '    throw new RangeError("Invoice total dropped below subtotal");',
  '  }',
  '  return total;',
  '};',
  '',
].join('\n');
const fixed = broken.replace('subtotal - fee', 'subtotal + fee');
const recipeFile = '.cevra-recipes.json';

function recipes(...definitions) {
  return JSON.stringify({ schemaVersion: 2, recipes: definitions.map(([id, name, ...steps]) => ({ id, name, steps })) });
}

function gitCommand(project) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(project, '.git', 'qa-global-config') };
  return async (...args) => (await execute('git', args, { cwd: project, env, windowsHide: true })).stdout.trim();
}

function button(container, name) {
  return container.getByRole('button', { name, exact: true });
}

async function chooseRecipe(page, id) {
  await button(page, 'Recipes').click();
  await page.getByLabel('Recipe', { exact: true }).selectOption(id);
}

test('G9 Windows desktop benchmark repairs, verifies, reviews, and commits an invoice regression',
  { timeout: 90_000, skip: !windows }, async t => {
    const actions = [];
    async function measure(action, operation) {
      const start = performance.now();
      await operation();
      actions.push({ action, ms: Math.round(performance.now() - start) });
    }
    const workbench = await openWorkbench(t, {
      [source]: broken,
      'invoice-demo.cjs': 'require(' + JSON.stringify('./' + source) + ')(100, 20);\n',
      'invoice.test.cjs': 'const assert = require("node:assert/strict");\n' +
        'const total = require(' + JSON.stringify('./' + source) + ');\n' +
        'require("node:test")("total includes the fee", () => assert.equal(total(100, 20), 120));\n',
      'package.json': JSON.stringify({ scripts: {
        compile: 'node --check invoice-demo.cjs && echo G9-COMPILE',
        verify: 'node --check invoice.test.cjs && echo G9-VERIFY',
      } }),
      '.cevra-tasks.json': JSON.stringify({ schemaVersion: 1, tasks: [
        { id: 'compile', profile: 'compile', after: [] },
        { id: 'verify', profile: 'verify', after: ['compile'] },
      ] }),
      [recipeFile]: recipes(
        ['reproduce', 'Reproduce invoice failure', { kind: 'test' }],
        ['inspect', 'Inspect invoice total', { kind: 'debug', file: 'invoice-demo.cjs' }],
        ['verify', 'Verify invoice repair', { kind: 'task', target: 'dag:verify' }, { kind: 'test' }],
      ),
    }, async project => {
      const git = gitCommand(project);
      await git('init', '-b', 'main', '--template=');
      await git('config', 'user.name', 'CEVRA Continuum QA');
      await git('config', 'user.email', 'continuum@example.invalid');
      await git('config', 'core.autocrlf', 'false');
      await git('add', '--all');
      await git('commit', '-m', 'Seed invoice regression');
    });
    const { app, page, project, state, output, editor, selected, openMs } = workbench;
    actions.push({ action: 'Launch and open fixture', ms: openMs });
    const git = gitCommand(project);
    const initial = await git('rev-parse', 'HEAD');
    const flightpath = button(page, 'Flightpath');
    const capsules = page.getByRole('list', { name: 'Run Capsules, newest first' }).getByRole('listitem');
    const failureLens = page.getByRole('region', { name: 'Failure Lens', exact: true });
    const debugStatus = page.locator('#debug-status');
    const changes = button(page, 'Change Lens');
    const changeLens = page.getByRole('region', { name: 'Change Lens', exact: true });
    const staged = changeLens.getByRole('list', { name: 'Staged changes' });
    const working = changeLens.getByRole('list', { name: 'Working changes' });
    const patch = changeLens.getByLabel('Git diff', { exact: true });
    const proof = page.locator('#git-proof');
    const run = button(page, 'Run recipe');
    const goalField = page.getByRole('textbox', { name: 'Workstream', exact: true });
    const testEvidence = page.locator('#test-revision');
    const titleRevision = async locator => (await locator.getAttribute('title')).split('\n')[1];
    let revisionA;
    let revisionB;
    let commit;

    await app.evaluate(({ dialog }) => {
      globalThis.continuumPrompts = [];
      dialog.showMessageBox = async (_window, options) => {
        globalThis.continuumPrompts.push(options);
        return { response: options.buttons.includes('Trust Workspace') ? 2 : 1 };
      };
    });
    await measure('Enable Flightpath and name Workstream', async () => {
      await flightpath.click();
      await button(page, 'Enable local history').click();
      await page.getByText(/^Local history is on/).waitFor();
      assert.equal(await capsules.count(), 0);
      await button(page, 'Run output').click();
      await state.getByText('Ready', { exact: true }).waitFor();
      assert.deepEqual(await app.evaluate(() => globalThis.continuumPrompts), []);
      await goalField.fill(goal);
    });

    await measure('Review and run failing recipe with workspace consent', async () => {
      await chooseRecipe(page, 'reproduce');
      await page.locator('#recipe-trust').getByText(/^Untrusted workspace/).waitFor();
      await page.locator('#recipe-preview').getByText('Full JavaScript test suite', { exact: true }).waitFor();
      await run.click();
      await state.getByText('Recipe failed', { exact: true }).waitFor();
      await testEvidence.getByText(/^Workspace inputs observed/).waitFor();
      revisionA = await titleRevision(testEvidence);
      assert.match(revisionA, /^[a-f0-9]{64}$/);
      assert.match(await testEvidence.getAttribute('title'), /^Repair calculation regression\n/);
      assert.equal(await git('rev-parse', 'HEAD'), initial);
    });

    await measure('Open Failure Lens and navigate recorded source', async () => {
      await button(page, 'Failure Lens').click();
      await page.locator('#debug-summary').getByText('Invoice total dropped below subtotal', { exact: true }).waitFor();
      await failureLens.getByRole('button', { name: /Recorded failure · .*total # %\.cjs:4:11/ }).click();
      await selected(filename).waitFor();
      await page.locator('#cursor').getByText('Ln 4, Col 11', { exact: true }).waitFor();
    });

    await measure('Set breakpoint and inspect the live total', async () => {
      await editor.press('F9');
      await failureLens.getByRole('list', { name: 'Breakpoints' }).getByText(/:4 · pending/).waitFor();
      await chooseRecipe(page, 'inspect');
      await page.locator('#recipe-trust').getByText(/^Trusted workspace/).waitFor();
      await run.click();
      await debugStatus.getByText('Paused · Entry', { exact: true }).waitFor();
      await page.keyboard.press('F5');
      await debugStatus.getByText('Paused · Breakpoint', { exact: true }).waitFor();
      const variables = page.locator('#debug-variables');
      await variables.getByText('total', { exact: true }).waitFor();
      await variables.getByText('80', { exact: true }).waitFor();
      await button(failureLens, 'Stop debugging').click();
      await debugStatus.getByText('Debug session stopped', { exact: true }).waitFor();
    });

    await measure('Fix source and observe historical evidence', async () => {
      await flightpath.click();
      const prior = capsules.filter({ hasText: 'Project tests · Failed' });
      await prior.getByText(/^Workspace inputs observed/).waitFor();
      assert.equal(await prior.locator('[title]').getAttribute('title'), revisionA);
      await replaceEditor(workbench, fixed);
      await prior.getByText(/^Historical/).waitFor();
      await editor.press('Control+s');
      await page.locator('#message').getByText(/^Saved .*total # %\.cjs$/).waitFor();
      assert.equal(await fs.readFile(path.join(project, source), 'utf8'), fixed);
    });

    await measure('Review working diff and stage the fix', async () => {
      await changes.click();
      await proof.getByText(/latest full test run did not establish a matching pass/).waitFor();
      await button(working, source + ' · M').click();
      await patch.getByText(/\+  const total = subtotal \+ fee;/).waitFor();
      assert.match(await patch.textContent(), /-  const total = subtotal - fee;/);
      await button(changeLens, 'Stage file').click();
      await button(staged, source + ' · M').waitFor();
      await proof.getByText(/^Historical/).waitFor();
    });

    await measure('Verify dependency graph and run the full test suite', async () => {
      await chooseRecipe(page, 'verify');
      const preview = page.locator('#recipe-preview');
      await preview.getByText(/After compile/).waitFor();
      await run.click();
      await state.getByText(/^Completed ·/).waitFor();
      assert.match(await output.textContent(), /G9-COMPILE[\s\S]*G9-VERIFY[\s\S]*\[Recipe · 2\. Project tests\]/);
      await testEvidence.getByText(/^Workspace inputs observed/).waitFor();
      revisionB = await titleRevision(testEvidence);
      assert.match(revisionB, /^[a-f0-9]{64}$/);
      assert.notEqual(revisionB, revisionA);
      assert.match(await testEvidence.getAttribute('title'), /^Repair calculation regression\n/);
      await flightpath.click();
      await capsules.first().getByText('Project tests · Passed', { exact: true }).waitFor();
      assert.equal(await capsules.first().locator('[title]').getAttribute('title'), revisionB);
      assert.deepEqual(await capsules.locator('strong').allTextContents(), [
        'Project tests · Passed', 'Task verify · Passed', 'Task compile · Passed', 'Project tests · Failed',
      ]);
    });

    await measure('Review staged proof and commit exact verified bytes', async () => {
      await changes.click();
      await proof.getByText('Staged source bytes match the latest full test pass.', { exact: true }).waitFor();
      assert.equal(await proof.getAttribute('title'), 'Test revision ' + revisionB + '\nStaged revision ' + revisionB);
      await button(staged, source + ' · M').click();
      await patch.getByText(/\+  const total = subtotal \+ fee;/).waitFor();
      await button(changeLens, 'Review commit').click();
      await changeLens.getByLabel('Commit message', { exact: true }).fill('Repair invoice calculation');
      assert.equal(await git('rev-parse', 'HEAD'), initial);
      await button(changeLens, 'Commit staged changes').click();
      const history = changeLens.getByRole('list', { name: 'Commit history' });
      const newCommit = history.getByText(/Repair invoice calculation/);
      await newCommit.waitFor();
      commit = await newCommit.getAttribute('title');
      assert.match(commit, /^[a-f0-9]{40,64}$/);
      assert.notEqual(commit, initial);
      assert.equal(await git('rev-parse', 'HEAD'), commit);
      assert.equal(await git('rev-parse', 'HEAD^'), initial);
      assert.equal(await git('diff-tree', '--no-commit-id', '--name-only', '-z', '-r', 'HEAD'), source + '\0');
      assert.equal((await git('show', 'HEAD:' + source)) + '\n', fixed);
      assert.equal(await git('status', '--porcelain'), '');
    });

    await measure('End Workstream and retain its recorded result', async () => {
      await button(page, 'Recipe output').click();
      await button(page, 'End Workstream').click();
      assert.equal(await goalField.inputValue(), '');
      assert.equal(await titleRevision(testEvidence), revisionB);
      assert.match(await testEvidence.getAttribute('title'), /^Repair calculation regression\n/);
    });

    const prompts = await app.evaluate(() => globalThis.continuumPrompts);
    assert.deepEqual(prompts.map(prompt => prompt.buttons), [
      ['Cancel', 'Run Once', 'Trust Workspace'], ['Cancel', 'Run Recipe'], ['Cancel', 'Run Recipe'], ['Cancel', 'Commit'],
    ]);
    assert.match(prompts.at(-1).detail, /match the latest full test pass/);
    t.diagnostic('CONTINUUM ' + JSON.stringify({
      schemaVersion: 1, os: os.release(), arch: os.arch(), electron: require('electron/package.json').version,
      runtime: await app.evaluate(() => process.versions.node),
      actions, measuredMs: actions.reduce((total, action) => total + action.ms, 0), revisionA, revisionB, fixtureCommit: commit,
    }));
  });

test('G9 Windows fault replay denies missing runtime, cancels the process tree, and recovers the draft after a crash',
  { timeout: 50_000, skip: !windows }, async t => {
    const workbench = await openWorkbench(t, {
      [recipeFile]: recipes(
        ['missing', 'Unavailable workspace Python', { kind: 'run', file: 'marker.cjs' }, { kind: 'run', file: 'entry.py', profile: '.venv' }],
        ['cancel', 'Cancel a process tree', { kind: 'run', file: 'tree.cjs' }, { kind: 'run', file: 'marker.cjs' }],
      ),
      'marker.cjs': 'require("node:fs").writeFileSync("unexpected.txt", "started");\n',
      'entry.py': 'print("must not start")\n',
      'notes.txt': 'Saved before the crash.\n',
      'tree.cjs': [
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
        '  { stdio: "ignore", detached: true, windowsHide: true });',
        'child.once("spawn", () => console.log("G9-TREE " + process.pid + " " + child.pid));',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    });
    const { page, project, state, output } = workbench;
    const run = button(page, 'Run recipe');
    await chooseRecipe(page, 'missing');
    await page.locator('#recipe-status').getByText(/Python interpreter is unavailable for entry\.py/).waitFor();
    assert.ok(await run.isDisabled());
    await assert.rejects(fs.access(path.join(project, 'unexpected.txt')), { code: 'ENOENT' });

    await chooseRecipe(page, 'cancel');
    await run.click();
    const marker = /G9-TREE (\d+) (\d+)/;
    await output.getByText(marker).waitFor();
    const pids = marker.exec(await output.textContent()).slice(1).map(Number);
    for (const pid of pids) process.kill(pid, 0);
    await button(page, 'Stop run').click();
    await state.getByText('Canceled', { exact: true }).waitFor();
    await Promise.all(pids.map(assertWindowsProcessStopped));
    await page.locator('#task-steps li').nth(1).getByText('Blocked', { exact: true }).waitFor();
    await assert.rejects(fs.access(path.join(project, 'unexpected.txt')), { code: 'ENOENT' });

    await workbench.open('notes.txt');
    await replaceEditor(workbench, 'Recover this unsaved draft.\n');
    assert.equal(await fs.readFile(path.join(project, 'notes.txt'), 'utf8'), 'Saved before the crash.\n');
    const reopened = await workbench.restart({ crash: true });
    await reopened.selected('notes.txt').waitFor();
    await reopened.editor.getByText('Recover this unsaved draft.', { exact: true }).waitFor();
    assert.equal(await fs.readFile(path.join(project, 'notes.txt'), 'utf8'), 'Saved before the crash.\n');
    await reopened.editor.press('Control+s');
    await reopened.page.locator('#message').getByText('Saved notes.txt', { exact: true }).waitFor();
    assert.equal(await fs.readFile(path.join(project, 'notes.txt'), 'utf8'), 'Recover this unsaved draft.\n');
  });
