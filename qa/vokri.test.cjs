const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { temporaryFolder } = require('./temp.cjs');
const { frame, maxFrameBytes, readFrames, serve } = require('../vokri/bridge/stdio.cjs');
const { createCevraService } = require('../vokri/hosts/cevra/service.cjs');

const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist', 'vokri');
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const manifest = path.join(root, 'vokri', 'hosts', 'cevra', 'vokri.manifest');

async function collect(source) {
  const packets = [];
  for await (const packet of readFrames(source)) packets.push(packet);
  return packets;
}

test('Vokri frames handle split headers, UTF-8, validation and service disposal', async () => {
  const request = (id, operation, args = {}) => frame({ version: 1, id, operation, arguments: args });
  const bytes = Buffer.concat([request(1, 'echo', { value: 'café 😀' }), request(2, 'constructor')]);
  const chunks = Array.from(bytes, byte => Buffer.from([byte]));
  const response = new PassThrough();
  const packets = collect(response);
  let disposed = 0;
  await serve(Readable.from(chunks), response, {
    echo(args, notify) { notify('echoed', args); return args; },
  }, () => { disposed++; });
  response.end();
  assert.deepEqual(await packets, [
    { version: 1, event: 'echoed', data: { value: 'café 😀' } },
    { version: 1, id: 1, ok: true, result: { value: 'café 😀' } },
    { version: 1, id: 2, ok: false, error: { code: 'UNKNOWN_OPERATION', message: 'Unknown service operation.' } },
  ]);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(maxFrameBytes + 1);
  await assert.rejects(collect(Readable.from([oversized])), /frame length/);
  await assert.rejects(collect(Readable.from([bytes.subarray(0, 6)])), /Truncated/);
  await assert.rejects(collect(Readable.from([Buffer.from([1, 0, 0, 0, 0xff])])), /utf-8/i);
  await assert.rejects(serve(Readable.from([request(2, 'echo'), request(2, 'echo')]),
    new PassThrough(), { echo: () => ({}) }, () => { disposed++; }), /envelope/);
  assert.equal(disposed, 2);
});

test('Vokri workspace routes enforce containment, revision safety and recovery conflicts', async t => {
  const temp = await temporaryFolder(t, 'cevra-vokri-service-');
  const project = path.join(temp, 'project');
  const profile = path.join(temp, 'profile');
  await fs.mkdir(project);
  const file = path.join(project, 'app.js');
  await fs.writeFile(file, 'console.log("disk");\r\n');
  const service = createCevraService(profile);
  const { routes } = service;
  try {
    const { workspace } = await routes.open({ folder: project });
    const document = { workspaceId: workspace.id, path: 'app.js' };
    assert.throws(() => routes.list({ ...document, path: '..' }), /workspace/i);
    await assert.rejects(routes.read({ ...document, workspaceId: 'stale', expectedRevision: null }), { code: 'STALE_WORKSPACE' });
    await fs.writeFile(path.join(temp, 'app.js'), 'outside the workspace');
    await fs.symlink(temp, path.join(project, 'outside'), 'junction');
    await assert.rejects(routes.read({ ...document, path: 'outside/app.js', expectedRevision: null }), /workspace|link/i);
    const { revision } = await routes.read({ ...document, expectedRevision: null });
    const draft = { ...document, revision, text: 'console.log("draft");\n' };
    await routes.draft(draft);
    await fs.writeFile(file, 'console.log("external");\r\n');
    await assert.rejects(routes.save(draft), /changed/i);
    await assert.rejects(routes.read({ ...document, expectedRevision: revision }), { code: 'STALE_DOCUMENT' });
    const recovered = await routes.read({ ...document, expectedRevision: null });
    assert.equal(recovered.text, draft.text);
    assert.equal(recovered.conflict, true);
    assert.equal(recovered.recovered, true);
    const copy = await routes['save-copy'](draft);
    assert.equal(await fs.readFile(file, 'utf8'), 'console.log("external");\r\n');
    assert.equal(await fs.readFile(path.join(project, copy.path), 'utf8'), 'console.log("draft");\r\n');
    assert.equal(copy.draftCleared, true);
  } finally {
    await service.close();
  }
});

async function compile(name, source, options) {
  const file = path.join(output, name + '.exe');
  await execute(compiler, ['/nologo', '/platform:x64', '/target:exe', '/warnaserror+', '/out:' + file,
    ...options, path.join(__dirname, source)], { windowsHide: true, timeout: 15000 });
  return file;
}

test('Vokri SDK runs native windows and owns an independent service connection', async t => {
  const checks = await compile('Vokri.FrameworkChecks', 'vokri-framework.cs', [
    '/reference:' + path.join(output, 'Vokri.dll'), '/reference:Accessibility.dll', '/win32manifest:' + manifest,
  ]);
  const temp = await temporaryFolder(t, 'cevra-vokri-sdk-');
  const script = path.join(temp, 'independent-service.cjs');
  await fs.writeFile(script, `
    const { serve } = require(${JSON.stringify(require.resolve('../vokri/bridge/stdio.cjs'))});
    const keepAlive = setInterval(() => {}, 1000);
    serve(process.stdin, process.stdout, {
      echo(args, notify) {
        notify('echo', { environment: process.env.VOKRI_QA_CONTEXT });
        return { ...args, argument: process.argv[2] };
      },
      hang: () => new Promise(() => {}),
    }, () => clearInterval(keepAlive)).catch(() => { process.exitCode = 1; });
  `);
  const { stdout } = await execute(checks, [process.execPath, script], { timeout: 15000, windowsHide: true });
  assert.match(stdout, /accessibility and dispatch checks passed/);
});

function launch(profile, project) {
  const child = spawn(path.join(output, 'Vokri.Cevra.exe'),
    [process.execPath, root, profile, ...(project ? [project] : [])], { stdio: 'ignore', windowsHide: true });
  const exited = once(child, 'exit');
  void exited.catch(() => {});
  return { child, exited };
}

async function until(read, predicate, message) {
  const deadline = Date.now() + 10000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(70);
  } while (Date.now() < deadline);
  assert.fail(message + ' Last value: ' + value);
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('native CEVRA saves, runs and recovers nested files on a Windows desktop', { timeout: 85000 }, async t => {
  const temp = await temporaryFolder(t, 'cevra-vokri-desktop-');
  const project = path.join(temp, 'Project (QA) & café [#%]');
  const nestedName = 'nested (QA) & café';
  const nested = path.join(project, nestedName);
  const profile = path.join(temp, 'profile');
  const main = 'entry.cjs';
  const fault = 'fault.cjs';
  const invalid = 'invalid.cjs';
  const slow = 'slow.cjs';
  const typed = 'typed.ts';
  const testFile = 'math.test.cjs';
  const starter = '\uFEFFrequire("./fault.cjs");\r\n';
  await fs.mkdir(nested, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(nested, main), starter),
    fs.writeFile(path.join(nested, fault), 'console.log("Vokri nested fixture");\nthrow new Error("nested failure");\n'),
    fs.writeFile(path.join(nested, invalid), 'const invalid = ;\n'),
    fs.writeFile(path.join(nested, slow), 'console.log("Vokri child " + process.pid);\nsetInterval(() => {}, 1000);\n'),
    fs.writeFile(path.join(nested, typed), 'enum Value { Ready = 3 }\nconsole.log("Vokri typed " + Value.Ready);\n'),
    fs.writeFile(path.join(nested, testFile), 'require("node:test")("vokri fixture", () => { throw new Error("test failure"); });\n'),
  ]);
  const probe = await compile('Vokri.Probe', 'vokri-probe.cs', []);
  let desktop = launch(profile, project);
  const send = async (...args) => {
    const { stdout } = await execute(probe, [String(desktop.child.pid), ...args], { timeout: 15000, windowsHide: true });
    return stdout.replace(/\r\n?/g, '\n');
  };
  const click = caption => send('click', caption);
  const wait = text => send('wait', text);
  const open = async name => {
    await send('select', name);
    await click('Open Selected');
    await wait('Opened ' + path.join(nestedName, name));
  };
  const start = async button => {
    await click(button);
    await send('confirm', 'Run workspace code');
  };
  const waitExit = async () => {
    await until(() => desktop.child.exitCode ?? desktop.child.signalCode, value => value !== null, 'Desktop process did not exit.');
    return desktop.exited;
  };
  try {
    await wait('Workspace opened.');
    await click('Open Folder');
    await send('cancel', 'Open CEVRA project');
    await send('select', nestedName);
    await click('Open Selected');
    await wait(nestedName);
    await open(main);
    assert.equal(await send('editor'), 'require("./fault.cjs");\n');
    await send('type', '/* café */ ');
    await click('Save');
    await wait('Saved ' + path.join(nestedName, main));
    const saved = '\uFEFF/* café */ require("./fault.cjs");\r\n';
    assert.equal(await fs.readFile(path.join(nested, main), 'utf8'), saved);
    await start('Run File');
    await wait('Failed.');
    assert.match(await send('output'), /Vokri nested fixture[\s\S]*nested failure/);
    await click('Go to Error');
    await wait('Error at ' + path.join(nestedName, fault) + ':2:');
    assert.match(await send('editor'), /throw new Error/);
    await fs.appendFile(path.join(nested, fault), '// external edit\n');
    await click('Go to Error');
    await wait('The reported source has changed.');

    await open(invalid);
    await start('Run File');
    await wait('Failed.');
    assert.match(await send('output'), /SyntaxError/);
    await click('Go to Error');
    await wait('Error at ' + path.join(nestedName, invalid) + ':1:');

    await start('Run Tests');
    await wait('Failed.');
    assert.match(await send('output'), /vokri fixture/);
    await start('Retry Failed');
    await wait('Failed.');
    assert.match(await send('output'), /vokri fixture/);
    await fs.writeFile(path.join(nested, testFile), 'require("node:test")("vokri fixture", () => {});\n');
    await start('Run Tests');
    await wait('Passed.');

    await open(typed);
    await start('Run File');
    await wait('Passed.');
    assert.match(await send('output'), /Vokri typed 3/);

    await open(slow);
    await start('Run File');
    const childOutput = await until(() => send('output'), text => /Vokri child \d+/.test(text), 'No running child process.');
    const stoppedPid = Number(/Vokri child (\d+)/.exec(childOutput)[1]);
    await click('Stop');
    await wait('Stopped.');
    await until(() => processExists(stoppedPid), running => !running, 'Stopped process survived.');

    await open(main);
    await send('type', '/* recover me */ ');
    await wait('Draft backed up.');
    await open(slow);
    await start('Run File');
    const crashOutput = await until(() => send('output'), text => /Vokri child \d+/.test(text), 'No child process before desktop crash.');
    const crashedPid = Number(/Vokri child (\d+)/.exec(crashOutput)[1]);
    assert.equal(desktop.child.kill(), true);
    await waitExit();
    await until(() => processExists(crashedPid), running => !running, 'The runner survived forced desktop termination.');
    assert.equal(await fs.readFile(path.join(nested, main), 'utf8'), saved);

    desktop = launch(profile);
    await wait('Recovered 1 draft.');
    assert.equal(await send('editor'), '/* recover me */ /* café */ require("./fault.cjs");\n');
    await click('Save');
    await wait('Saved ' + path.join(nestedName, main));
    assert.equal(await fs.readFile(path.join(nested, main), 'utf8'), '\uFEFF/* recover me */ /* café */ require("./fault.cjs");\r\n');
    await send('close');
    const [code] = await waitExit();
    assert.equal(code, 0);
  } finally {
    desktop.child.kill();
    await desktop.exited.catch(() => {});
  }
});
