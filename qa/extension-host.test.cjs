const assert = require('node:assert/strict');
const { execFile, fork, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { artifacts, openIsolationLab } = require('../src/extensions/host-lab/supervisor.cjs');
const { assertWindowsProcessStopped, openWorkbench, replaceEditor } = require('./desktop-workbench.cjs');
const { temporaryFolder } = require('./temp.cjs');

const header = Buffer.from('0061736d01000000', 'hex');
const section = (type, payload) => Buffer.from([type, payload.length, ...payload]);
const name = value => [value.length, ...Buffer.from(value, 'ascii')];
const signature = section(1, [1, 0x60, 0, 1, 0x7f]);
const wasm = (ops, memory = Buffer.alloc(0)) => Buffer.concat([
  header, signature, section(3, [1, 0]), memory, section(7, [1, ...name('run'), 0, 0]),
  section(10, [1, ops.length + 1, 0, ...ops]),
]);
const answer = wasm([0x41, 42, 0x0b]);
const execute = promisify(execFile);

async function lab(t, options) {
  const scratch = await temporaryFolder(t, 'cevra-host-');
  const host = await openIsolationLab(scratch, options);
  t.after(() => host.stop());
  return { host, scratch };
}

async function listener(t, host) {
  const server = net.createServer(socket => socket.destroy());
  server.listen(0, host);
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return server.address().port;
}

async function ordinaryProbe(payload, env) {
  const process = spawn(path.join(artifacts, 'extension-probe.exe'), [], {
    stdio: ['pipe', 'pipe', 'ignore'], env, windowsHide: true,
  });
  const chunks = [];
  process.stdout.on('data', chunk => chunks.push(chunk));
  const prefix = Buffer.alloc(5);
  prefix.writeUInt32LE(payload.length + 1);
  prefix[4] = 3;
  process.stdin.end(Buffer.concat([prefix, payload]));
  assert.deepEqual(await once(process, 'close'), [0, null]);
  const response = Buffer.concat(chunks);
  assert.equal(response.length, 22);
  assert.equal(response[17], 20);
  return response.readUInt32LE(18);
}

test('LPAC and Wasmtime exchange a heartbeat and execute a bounded core module', { timeout: 25_000 }, async t => {
  const { host, scratch } = await lab(t);
  await host.ping();
  await host.ping();
  await assert.rejects(host.run(Buffer.alloc(256 * 1024)), { code: 'HOST_QUOTA' });
  assert.equal(await host.run(answer), 42);
  const { code, stderr } = await host.closed;
  assert.equal(code, 0, stderr);
  await assertWindowsProcessStopped(host.pid);
  assert.deepEqual(await fs.readdir(scratch), []);
});

test('LPAC Wasmtime rejects unsupported imports, invalid modules, excess memory and infinite guest work',
  { timeout: 45_000 }, async t => {
    const fixtures = [
      [Buffer.concat([header, signature, section(2, [1, ...name('wasi_snapshot_preview1'), ...name('fd_write'), 0, 0])]), 'imports-denied'],
      [Buffer.from('invalid module'), 'invalid-module'],
      [wasm([0x41, 0, 0x0b], section(5, [1, 0, 0x81, 0x02])), 'quota-or-trap'],
      [wasm([0x03, 0x40, 0x0c, 0, 0x0b, 0x41, 0, 0x0b]), 'quota-or-trap'],
    ];
    for (const [bytes, message] of fixtures) {
      const { host, scratch } = await lab(t);
      await assert.rejects(host.run(bytes), { code: 'GUEST_REJECTED', message });
      assert.equal((await host.closed).code, 0);
      assert.deepEqual(await fs.readdir(scratch), []);
    }
  });

test('LPAC denies controlled native file, environment, network, subprocess, handle and clipboard probes',
  { timeout: 30_000 }, async t => {
    const root = await temporaryFolder(t, 'cevra-probe-');
    const workspace = path.join(root, 'workspace sentinel café.txt');
    const profile = path.join(root, 'private app data sentinel.txt');
    await fs.writeFile(workspace, 'fixture');
    await fs.writeFile(profile, 'fixture');
    const loopback = await listener(t, '127.0.0.1');
    const adapter = Object.values(os.networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal);
    assert.ok(adapter, 'The Windows runner needs a local IPv4 interface for the non-loopback fixture.');
    const local = await listener(t, adapter.address);
    const clipboardFixture = process.env.CEVRA_TEST_CLIPBOARD === '1';
    if (clipboardFixture) {
      assert.equal(process.env.GITHUB_ACTIONS, 'true');
      assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
      const clipboard = command => execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command',
        command], { windowsHide: true });
      await clipboard("Set-Clipboard -Value 'CEVRA disposable isolation fixture'");
      t.after(() => clipboard('Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.Clipboard]::Clear()'));
    }
    const payload = Buffer.from([workspace, profile, loopback, adapter.address, local, process.pid,
      clipboardFixture ? 'clipboard-fixture' : 'policy-only'].join('\n'));
    const env = { ...process.env, CEVRA_G3_SENTINEL: 'fixture-only' };
    const baseline = await ordinaryProbe(payload, env);
    assert.equal(baseline, clipboardFixture ? 767 : 639, 'The unrestricted native control reaches the disposable fixtures.');
    const previous = process.env.CEVRA_G3_SENTINEL;
    process.env.CEVRA_G3_SENTINEL = 'fixture-only';
    try {
      const { host, scratch } = await lab(t, { mode: 'probe' });
      assert.equal(await host.probe(3, payload), 0, 'Every native probe must be denied.');
      assert.equal((await host.closed).code, 0);
      assert.deepEqual(await fs.readdir(scratch), []);
    } finally {
      if (previous === undefined) delete process.env.CEVRA_G3_SENTINEL;
      else process.env.CEVRA_G3_SENTINEL = previous;
    }
  });

test('the supervisor stops hung, crashed and malformed native hosts', { timeout: 35_000 }, async t => {
  for (const [operation, code] of [
    [4, 'HOST_TIMEOUT'], [5, 'HOST_EXIT'], [6, 'HOST_PROTOCOL'], [7, 'HOST_TIMEOUT'], [8, 'HOST_QUOTA'],
  ]) {
    const { host, scratch } = await lab(t, { mode: 'probe', deadline: 500 });
    await assert.rejects(host.probe(operation), { code });
    await host.closed;
    await assertWindowsProcessStopped(host.pid);
    assert.deepEqual(await fs.readdir(scratch), []);
  }
  const { host, scratch } = await lab(t, { mode: 'probe' });
  const reply = assert.rejects(host.probe(4), { code: 'HOST_STOPPED' });
  await host.stop();
  await reply;
  await assertWindowsProcessStopped(host.pid);
  assert.deepEqual(await fs.readdir(scratch), []);
});

test('a terminated owner loses its host and scratch files', { timeout: 25_000 }, async t => {
  const scratch = await temporaryFolder(t, 'cevra-owner-');
  const owner = fork(path.join(__dirname, 'extension-host-owner.cjs'), [scratch], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); });
  const [state] = await once(owner, 'message');
  assert.ok(state.pid && state.launcherPid, state.error);
  const exit = once(owner, 'exit');
  owner.kill('SIGKILL');
  await exit;
  await assertWindowsProcessStopped(state.pid);
  await assertWindowsProcessStopped(state.launcherPid);
  const remaining = await fs.readdir(scratch);
  const contents = await Promise.all(remaining.map(name => fs.readdir(path.join(scratch, name))));
  assert.deepEqual(remaining, [], JSON.stringify(contents));
});

test('a native host crash leaves a real CEVRA editor draft recoverable', { timeout: 40_000 }, async t => {
  const workbench = await openWorkbench(t, { 'draft.txt': 'saved baseline\n' });
  await workbench.open('draft.txt');
  await replaceEditor(workbench, 'backed up unsaved change\n');
  const { host } = await lab(t, { mode: 'probe' });
  await assert.rejects(host.probe(5), { code: 'HOST_EXIT' });
  await host.closed;
  await workbench.editor.getByText('backed up unsaved change', { exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(workbench.project, 'draft.txt'), 'utf8'), 'saved baseline\n');
  const recovered = await workbench.restart({ crash: true });
  await recovered.editor.getByText('backed up unsaved change', { exact: true }).waitFor();
});
