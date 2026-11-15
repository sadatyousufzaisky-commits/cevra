const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { temporaryFolder } = require('./temp.cjs');
const { compile, until, processExists } = require('./vokri-support.cjs');

const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');

test('the native product folder runs independently and recovers after a workspace service failure',
  { timeout: 90000 }, async t => {
    const temp = await temporaryFolder(t, 'vokri-native-product-');
    const install = path.join(temp, 'VOKRI Code (QA) & café');
    const workspace = path.join(temp, 'Work (QA) & café');
    const profile = path.join(temp, 'Profile');
    const cwd = path.join(temp, 'Unrelated working directory');
    const entry = path.join(workspace, 'nested', 'entry.cjs');
    await Promise.all([fs.mkdir(path.dirname(entry), { recursive: true }), fs.mkdir(cwd)]);
    await Promise.all([
      fs.writeFile(entry, 'require("./fault.cjs");\n'),
      fs.writeFile(path.join(workspace, 'nested', 'fault.cjs'), 'throw new Error("Staged native runner failure");\n'),
      fs.writeFile(path.join(workspace, 'math.test.cjs'), 'require("node:test")("staged reporter", () => {});\n'),
    ]);
    await execute(process.execPath, [path.join(root, 'scripts', 'build-vokri-product.cjs'), install],
      { timeout: 45_000, windowsHide: true, cwd });
    const packaged = JSON.parse(await fs.readFile(path.join(install, 'runtime-manifest.json'), 'utf8'));
    assert.equal(packaged.entryPoint, 'VokriCode.exe');
    const files = (await fs.readdir(install, { recursive: true, withFileTypes: true }))
      .filter(file => !file.isDirectory())
      .map(file => path.relative(install, path.join(file.parentPath, file.name)).replaceAll('\\', '/'));
    assert.deepEqual(files.sort(), ['runtime-manifest.json', ...Object.keys(packaged.files)].sort());
    assert.ok(files.every(file => !/(?:electron|chromium|webview|playwright|node_modules|\.asar)/i.test(file)));
    for (const [file, expected] of Object.entries(packaged.files)) {
      const actual = createHash('sha256').update(await fs.readFile(path.join(install, file))).digest('hex');
      assert.equal(actual, expected, file);
    }

    const probe = await compile('Vokri.Probe', 'vokri-probe.cs', []);
    const system = path.join(process.env.SystemRoot, 'System32');
    const powershell = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const native = path.join(install, packaged.entryPoint);
    function start(folder) {
      const child = spawn(native, ['--user-data-dir=' + profile, ...(folder ? [folder] : [])], {
        cwd, env: { ...process.env, Path: system, NODE_OPTIONS: '--require ./missing-runtime-fixture.cjs' }, stdio: 'ignore',
      });
      const exited = once(child, 'exit');
      void exited.catch(() => {});
      return { child, exited };
    }
    let app = start(workspace);
    const query = async (...args) => (await execute(probe, [app.child.pid, ...args], { timeout: 15000, windowsHide: true }))
      .stdout.replace(/\r\n?/g, '\n');
    const click = label => query('click', label);
    const wait = label => query('wait', label);
    async function serviceProcess() {
      const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' +
        'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter ' +
        '"ParentProcessId = ' + app.child.pid + '" | Select-Object ProcessId, ExecutablePath)'],
      { timeout: 15000, windowsHide: true });
      const children = JSON.parse(stdout);
      assert.equal(children.length, 1);
      assert.equal(children[0].ExecutablePath.toLowerCase(), path.join(install, 'runtime', 'node.exe').toLowerCase());
      return children[0].ProcessId;
    }

    try {
      await wait('Workspace opened.');
      const service = await serviceProcess();
      const { stdout: modules } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-Process -Id ' + app.child.pid + ',' + service + ').Modules | ForEach-Object { $_.ModuleName }'],
      { timeout: 15000, windowsHide: true });
      assert.match(modules, /VokriCode\.exe/i);
      assert.match(modules, /node\.exe/i);
      assert.doesNotMatch(modules, /electron|chromium|webview|msedge|libcef/i);
      await query('select', 'nested');
      await click('Open Selected');
      await query('select', 'entry.cjs');
      await click('Open Selected');
      await wait('Opened ' + path.join('nested', 'entry.cjs'));
      await click('Run File');
      await query('confirm', 'Run workspace code');
      await wait('Failed.');
      assert.match(await query('output'), /Staged native runner failure/);
      await click('Go to Error');
      await wait('Error at ' + path.join('nested', 'fault.cjs') + ':1:');
      await click('Run Tests');
      await query('confirm', 'Run workspace code');
      await wait('Passed.');
      await query('type', '/* recover after service failure */ ');
      await wait('Draft backed up.');
      process.kill(service, 'SIGKILL');
      await wait('Workspace service disconnected.');
      await query('close');
      assert.deepEqual(await app.exited, [0, null]);
      assert.equal(await fs.readFile(path.join(workspace, 'nested', 'fault.cjs'), 'utf8'),
        'throw new Error("Staged native runner failure");\n');

      app = start();
      await wait('Recovered 1 draft.');
      assert.match(await query('editor'), /^\/\* recover after service failure \*\//);
      await click('Save');
      await wait('Saved ' + path.join('nested', 'fault.cjs'));
      assert.match(await fs.readFile(path.join(workspace, 'nested', 'fault.cjs'), 'utf8'), /^\/\* recover after service failure \*\//);
      const recoveredService = await serviceProcess();
      await query('close');
      assert.deepEqual(await app.exited, [0, null]);
      await until(() => processExists(recoveredService), alive => !alive, 'The staged service survived window exit.');
    } finally {
      if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
      await app.exited.catch(() => {});
    }
  });
