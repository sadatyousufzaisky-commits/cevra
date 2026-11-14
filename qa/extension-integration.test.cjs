const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { assertWindowsProcessStopped, openWorkbench, replaceEditor } = require('./desktop-workbench.cjs');
const { executableArchive, json, zip } = require('./extension-fixtures.cjs');
const { brokerPackage, commandPackages, desktopHosts, manager, original, relative, starterTools, writePackage } =
  require('./extension-scenarios.cjs');

const entry = 'const entry = true;\n';
const draft = 'const entry = "G9 draft recovery";\n';
const activationTrap = Buffer.from('0061736d010000000105016000017f030201000707010372756e00000a05010300000b', 'hex');

test('Phase 4 Windows lifecycle isolates five concurrent hosts across denial, faults, update, restart and workspace switch',
  { timeout: 150_000 }, async t => {
    const declarative = await starterTools();
    const broker = await brokerPackage();
    const [first, second, third, fourth, overflow] = await commandPackages(5);
    const active = [broker, first, second, third, fourth];
    const broken = {
      manifest: { ...overflow.manifest, id: 'org.cevra.qa.activation-trap', displayName: 'QA Activation Trap' },
      module: activationTrap,
    };
    broken.bytes = executableArchive(broken.manifest, broken.module);
    const update = { ...first.manifest, version: '2.0.0', permissions: [
      ...first.manifest.permissions, { capability: 'editor.readSelection', files: ['entry.js'] },
    ] };
    const packages = new Map();
    let secondWorkspace;
    let invalidPackage;
    let workbench = await openWorkbench(t, {
      [relative]: original, 'entry.js': entry, 'private.txt': 'G9 PRIVATE FILE SENTINEL',
    }, async (_project, profile) => {
      const folder = path.dirname(profile);
      secondWorkspace = path.join(folder, 'second workspace & café');
      await fs.mkdir(secondWorkspace);
      await fs.writeFile(path.join(secondWorkspace, 'second.js'), 'const next = true;\n');
      for (const fixture of [declarative, ...active, overflow, broken]) {
        packages.set(fixture.manifest, await writePackage(folder, fixture));
      }
      packages.set(update, await writePackage(folder, { manifest: update, bytes: executableArchive(update, first.module) }));
      invalidPackage = path.join(folder, 'unsupported extra entry.zip');
      await fs.writeFile(invalidPackage, zip([{ bytes: json(declarative.manifest) }, { name: 'extra.txt', bytes: Buffer.from('fixture') }]));
    });
    let ui = manager(workbench.page);
    const status = value => ui.status.getByText(value, { exact: typeof value === 'string' }).waitFor();
    const rowState = (fixture, state) => ui.row(fixture).getByText(state, { exact: true }).waitFor();
    const click = (fixture, action) => ui.button(action, ui.row(fixture)).click();
    const choose = async filename => {
      await workbench.app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, filename);
      await ui.button('Choose ZIP Package').click();
    };
    const review = async manifest => {
      const { filename, digest } = packages.get(manifest);
      await choose(filename);
      await ui.dialog.getByRole('heading', { name: 'Review ' + manifest.displayName, exact: true }).waitFor();
      await ui.dialog.getByText(digest, { exact: true }).waitFor();
    };
    const activate = async fixture => {
      const started = performance.now();
      await click(fixture, 'Review Permissions');
      await rowState(fixture, 'Active for this session');
      await status('Permissions granted for this session.');
      return Math.round(performance.now() - started);
    };
    const runHello = async fixture => {
      await click(fixture, 'Run Say hello');
      await status('Command completed.');
    };
    const catalog = () => workbench.page.evaluate(async () => (await window.cevra.extensionRuntime()).catalog);
    const inspect = async fixture => (await catalog()).find(item => item.id === fixture.manifest.id);

    await ui.open();
    await choose(invalidPackage);
    await status(/requires extension\.json|must contain one regular extension\.json|invalid|unsupported/i);
    assert.deepEqual(await catalog(), []);
    for (const fixture of [declarative, ...active, overflow, broken]) {
      await review(fixture.manifest);
      await ui.button('Install Package').click();
      await rowState(fixture, 'Disabled');
      await click(fixture, 'Enable');
      await rowState(fixture, 'Enabled');
    }
    await workbench.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (_window, options) => ({ response: options.title === 'Extension permissions' ? 0 : 1 });
    });
    await click(first, 'Review Permissions');
    await status('Activation canceled.');
    assert.deepEqual(await desktopHosts(workbench.app), []);

    await workbench.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    const activationMs = [];
    for (const fixture of active) activationMs.push(await activate(fixture));
    const hosts = await desktopHosts(workbench.app);
    assert.equal(hosts.filter(item => item.worker).length, 5);
    assert.equal(hosts.filter(item => !item.worker).length, 5);
    await click(overflow, 'Review Permissions');
    await status(/VOKRI Code can run five executable extensions/);
    assert.equal((await desktopHosts(workbench.app)).length, 10);
    t.diagnostic('PHASE4_G9_ACTIVATION ' + JSON.stringify({ count: 5, activationMs }));

    await ui.button('Close').click();
    await workbench.open('entry.js');
    await replaceEditor(workbench, draft);
    await ui.open();
    await click(broker, 'Run Review saved answer');
    await ui.button('Review Edit', ui.row(broker)).waitFor();
    await click(broker, 'Run Trigger fixture failure');
    await rowState(broker, 'Stopped after a host failure');
    await ui.button('Review Edit', ui.row(broker)).waitFor({ state: 'detached' });
    await click(broken, 'Review Permissions');
    await rowState(broken, 'Stopped after a host failure');
    await runHello(second);
    await runHello(third);
    const remaining = await desktopHosts(workbench.app);
    assert.equal(remaining.length, 8);
    const survivorPids = new Set(remaining.map(item => item.pid));
    for (const item of hosts) {
      if (!survivorPids.has(item.pid)) await assertWindowsProcessStopped(item.pid);
    }

    await review(update);
    await ui.dialog.getByText('Added file scope · entry.js', { exact: true }).waitFor();
    await workbench.app.evaluate(({ app }) => {
      const fs = process.getBuiltinModule('node:fs/promises');
      const path = process.getBuiltinModule('node:path');
      const registry = path.join(app.getPath('userData'), 'extensions', 'registry.json');
      const rename = fs.rename;
      fs.rename = async (from, to) => {
        if (to === registry) {
          fs.rename = rename;
          throw new Error('G9 simulated registry write failure.');
        }
        return rename(from, to);
      };
    });
    await ui.button('Install Update').click();
    await status(/G9 simulated registry write failure/);
    assert.equal((await inspect(first)).sha256, packages.get(first.manifest).digest);
    await ui.button('Back to Installed').click();
    await runHello(first);
    await review(update);
    await ui.button('Install Update').click();
    await rowState(first, 'Disabled');
    const updated = await inspect(first);
    assert.equal(updated.sha256, packages.get(update).digest);
    assert.equal(updated.rollback.sha256, packages.get(first.manifest).digest);
    await ui.button('Run Say hello', ui.row(first)).waitFor({ state: 'detached' });
    await runHello(third);
    await click(second, 'Revoke Access');
    await status('Access revoked.');
    await ui.button('Run Say hello', ui.row(second)).waitFor({ state: 'detached' });
    await runHello(fourth);
    const beforeCrash = await desktopHosts(workbench.app);
    assert.equal(beforeCrash.length, 4);

    workbench = await workbench.restart({ crash: true });
    await Promise.all(beforeCrash.map(item => assertWindowsProcessStopped(item.pid)));
    await workbench.selected('entry.js').waitFor();
    assert.deepEqual(await workbench.editor.locator('.cm-line').allTextContents(), draft.split('\n'));
    assert.equal(await fs.readFile(path.join(workbench.project, 'entry.js'), 'utf8'), entry);
    assert.equal(await fs.readFile(path.join(workbench.project, relative), 'utf8'), original);
    const audit = await fs.readFile(path.join(workbench.profile, 'extensions', 'audit.json'), 'utf8');
    assert.ok(JSON.parse(audit).events.some(event => event.operation === 'workspace.readFile' && event.result === 'denied'));
    for (const privateValue of [workbench.project, relative, original.trim(), 'G9 PRIVATE FILE SENTINEL']) {
      assert.ok(!audit.includes(privateValue));
    }
    ui = manager(workbench.page);
    await ui.open();
    await rowState(first, 'Disabled');
    await ui.button('Run Say hello').waitFor({ state: 'detached' });
    await click(first, 'Enable');
    await workbench.app.evaluate(({ dialog }) => {
      globalThis.updateReviews = [];
      dialog.showMessageBox = async (_window, options) => {
        if (options.title === 'Extension permissions') globalThis.updateReviews.push(options.detail);
        return { response: 1 };
      };
    });
    await activate(first);
    const reviews = await workbench.app.evaluate(() => globalThis.updateReviews);
    assert.equal(reviews.length, 1);
    assert.ok(reviews[0].includes(packages.get(update).digest));
    assert.ok(reviews[0].includes('entry.js'));
    await runHello(first);
    const beforeSwitch = await desktopHosts(workbench.app);
    assert.equal(beforeSwitch.length, 2);
    await ui.button('Close').click();
    await workbench.app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, secondWorkspace);
    await workbench.page.locator('#open-folder').click();
    await workbench.file('second.js').waitFor();
    await Promise.all(beforeSwitch.map(item => assertWindowsProcessStopped(item.pid)));
    await ui.open();
    await rowState(first, 'Enabled');
    await ui.button('Run Say hello').waitFor({ state: 'detached' });
    for (const fixture of [declarative, ...active, overflow, broken]) {
      await click(fixture, 'Uninstall');
      await ui.row(fixture).waitFor({ state: 'detached' });
    }
    assert.deepEqual(await catalog(), []);
    assert.deepEqual(await desktopHosts(workbench.app), []);
  });
