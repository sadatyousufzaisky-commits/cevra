const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { limits, providerAbi } = require('../src/intelligence/provider-contract.cjs');
const { createProviderRegistry } = require('../src/intelligence/provider-registry.cjs');
const { mockProvider } = require('../src/intelligence/providers/mock.cjs');

const execute = promisify(execFile);
const input = (changes = {}) => ({
  abiVersion: providerAbi, requestId: 'case-1', providerId: 'mock', modelId: 'deterministic-v1',
  messages: [{ role: 'user', content: 'Test prompt.' }], maxOutputTokens: 16, ...changes,
});
const event = (kind, fields = {}) => ({ kind, requestId: 'case-1', ...fields });
const complete = () => event('complete', { finishReason: 'stop' });
const delta = (text = 'value') => event('text.delta', { text });
const usage = (outputTokens = 1) => event('usage', { inputTokens: 3, outputTokens });
const fixture = (stream, id = 'fixture') => ({
  catalog: { ...structuredClone(mockProvider.catalog), providerId: id, label: id, provenance: 'Test fixture v1' },
  stream,
});
const forFixture = changes => input({ providerId: 'fixture', ...changes });

function sequence(events) {
  return async function* () { yield* events; };
}

test('the built-in mock deterministically streams text, simulated usage and completion without opening a socket', async t => {
  const blocked = () => assert.fail('The mock attempted network access.');
  t.mock.method(globalThis, 'fetch', blocked);
  t.mock.method(http, 'request', blocked);
  t.mock.method(https, 'request', blocked);
  t.mock.method(net.Socket.prototype, 'connect', blocked);
  const registry = createProviderRegistry([mockProvider]);
  const events = await Array.fromAsync(registry.stream(input()));
  assert.deepEqual(events.map(value => value.kind), [
    'text.delta', 'text.delta', 'text.delta', 'text.delta', 'text.delta', 'text.delta', 'usage', 'complete',
  ]);
  assert.equal(events.slice(0, 6).map(value => value.text).join(''), 'This is an offline mock response.');
  assert.deepEqual(events.at(-2), usage(6));
  assert.deepEqual(events.at(-1), complete());
  assert.ok(events.every(Object.isFrozen));
  const limited = await Array.fromAsync(registry.stream(input({ requestId: 'case-2', maxOutputTokens: 2 })));
  assert.deepEqual(limited.map(value => value.requestId), Array(4).fill('case-2'));
  assert.equal(limited.at(-2).outputTokens, 2);
  assert.equal(limited.at(-1).finishReason, 'length');
});

test('catalogs are snapshotted, namespaced by provider, and reject false or ambiguous metadata', async () => {
  const first = fixture(sequence([complete()]));
  const second = fixture(sequence([delta('second provider'), complete()]), 'second');
  const registry = createProviderRegistry([first, second]);
  first.catalog.models[0].id = 'mutated';
  assert.ok(Object.isFrozen(registry.list()[0].models[0]));
  assert.equal(registry.list()[0].models[0].id, 'deterministic-v1');
  assert.deepEqual(await Array.fromAsync(registry.stream(forFixture())), [complete()]);
  assert.deepEqual(await Array.fromAsync(registry.stream(input({ providerId: 'second' }))), [delta('second provider'), complete()]);
  assert.throws(() => registry.stream(input({ providerId: 'missing' })), { code: 'PROVIDER_UNAVAILABLE' });
  assert.throws(() => registry.stream(forFixture({ modelId: 'missing' })), { code: 'MODEL_UNSUPPORTED' });
  assert.throws(() => createProviderRegistry([first, first]), { code: 'PROVIDER_PROTOCOL' });
  for (const change of [
    catalog => { catalog.abiVersion = '1.0'; },
    catalog => { catalog.models.push(catalog.models[0]); },
    catalog => { catalog.models[0].toolProposals = true; },
    catalog => { catalog.models[0].label = 'Control\u202e text'; },
    catalog => { catalog.models[0].maxOutputTokens = Infinity; },
    catalog => { catalog.models[0].extra = true; },
  ]) {
    const bad = fixture(sequence([]));
    change(bad.catalog);
    assert.throws(() => createProviderRegistry([bad]), { code: 'PROVIDER_PROTOCOL' });
  }
});

test('malformed or out-of-budget requests are rejected before any adapter invocation', () => {
  const registry = createProviderRegistry([fixture(() => assert.fail('The adapter was started.'))]);
  for (const change of [
    { abiVersion: '1.0' },
    { requestId: 'bad id' },
    { messages: [] },
    { messages: [{ role: 'tool', content: 'untrusted' }] },
    { messages: [{ role: 'user', content: '   ' }] },
    { messages: [{ role: 'user', content: '\ud800' }] },
    { messages: [{ role: 'user', content: '🧪'.repeat(2049) }] },
    { messages: Array(17).fill({ role: 'user', content: 'message' }) },
    { messages: [{ role: 'user', content: 'x'.repeat(65536) }, { role: 'user', content: 'y' }] },
    { maxOutputTokens: 129 },
    { maxOutputTokens: 1.5 },
    { credentialRef: 'fixture' },
    { approvedContextDigest: 'fixture' },
  ]) {
    assert.throws(() => registry.stream(forFixture(change)), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => registry.stream(forFixture(), { deadlineMs: 0 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => registry.stream(forFixture(), { signal: {} }), { code: 'INVALID_REQUEST' });
  const accessor = forFixture();
  Object.defineProperty(accessor, 'messages', { get: () => assert.fail('An accessor was read.') });
  assert.throws(() => registry.stream(accessor), { code: 'INVALID_REQUEST' });
});

test('stream validation rejects malformed, replayed, misordered and excessive events', async () => {
  for (const events of [
    [],
    [delta()],
    [null],
    [delta('\ud800')],
    [delta('é'.repeat(2049))],
    [event(['text.delta'], { text: 'invalid kind' })],
    [event('text.delta', { text: 'wrong request', requestId: 'case-2' })],
    [event('text.delta', { text: 'private header', headers: 'fixture' })],
    [event('error', { code: 'PROVIDER_UNAVAILABLE', retryable: true, message: 'unsafe detail' })],
    [event('error', { code: 'UNKNOWN', retryable: true })],
    [usage(17), complete()],
    [usage(), usage(), complete()],
    [usage(), delta(), complete()],
    [...Array(17).fill(delta('x'.repeat(limits.deltaBytes))), complete()],
    [...Array(limits.events).fill(delta()), complete()],
  ]) {
    const registry = createProviderRegistry([fixture(sequence(events))]);
    await assert.rejects(Array.fromAsync(registry.stream(forFixture())), { code: 'PROVIDER_PROTOCOL' });
  }
});

test('a typed provider failure ends the stream and a fresh request can retry explicitly', async () => {
  const failure = event('error', { code: 'RATE_LIMIT', retryable: true });
  let attempts = 0;
  const registry = createProviderRegistry([fixture(async function* (request) {
    attempts++;
    if (attempts === 1) {
      yield failure;
      assert.fail('Read past the terminal provider event.');
    }
    yield { ...complete(), requestId: request.requestId };
  })]);
  assert.deepEqual(await Array.fromAsync(registry.stream(forFixture())), [failure]);
  assert.equal(attempts, 1);
  assert.deepEqual(await Array.fromAsync(registry.stream(forFixture({ requestId: 'case-2' }))), [
    { ...complete(), requestId: 'case-2' },
  ]);
});

test('an asynchronous iterator can omit done on a yielded event', async () => {
  const registry = createProviderRegistry([fixture(() => ({
    [Symbol.asyncIterator]() { return this; },
    async next() { return { value: complete() }; },
  }))]);
  assert.deepEqual(await Array.fromAsync(registry.stream(forFixture())), [complete()]);
});

test('adapter exceptions return a fixed failure without leaking provider details', async () => {
  const registry = createProviderRegistry([fixture(async function* () {
    throw new Error('SYNTHETIC_PRIVATE_HEADER');
  })]);
  await assert.rejects(Array.fromAsync(registry.stream(forFixture())), {
    code: 'PROVIDER_UNAVAILABLE', message: 'The selected provider is unavailable.',
  });
});

function stalledAdapter(state) {
  return fixture((_request, signal) => {
    state.signal = signal;
    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        state.started.resolve();
        return new Promise(() => {});
      },
      return() { state.closed = true; return new Promise(() => {}); },
    };
  });
}

test('cancellation settles a stalled pull and closes the adapter even when it ignores abort', { timeout: 3000 }, async () => {
  const state = { started: Promise.withResolvers() };
  const registry = createProviderRegistry([stalledAdapter(state)]);
  const controller = new AbortController();
  const pending = registry.stream(forFixture(), { signal: controller.signal }).next();
  await state.started.promise;
  controller.abort('SYNTHETIC_PRIVATE_REASON');
  await assert.rejects(pending, { code: 'CANCELLED', message: 'Request stopped.' });
  assert.equal(state.closed, true);
  assert.equal(state.signal.aborted, true);
});

test('an already cancelled request never invokes its adapter and a stalled adapter meets the deadline',
  { timeout: 3000 }, async () => {
    const state = { started: Promise.withResolvers() };
    const registry = createProviderRegistry([stalledAdapter(state)]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(registry.stream(forFixture(), { signal: controller.signal }).next(), { code: 'CANCELLED' });
    assert.equal(state.signal, undefined);
    await assert.rejects(registry.stream(forFixture(), { deadlineMs: 20 }).next(), { code: 'PROVIDER_TIMEOUT' });
    assert.equal(state.closed, true);
    assert.equal(state.signal.aborted, true);
  });

test('consumer closure after a delta stops the upstream iterator', async () => {
  let stopped = false;
  const registry = createProviderRegistry([fixture(async function* (_request, signal) {
    try { yield delta(); }
    finally { stopped = signal.aborted; }
  })]);
  for await (const value of registry.stream(forFixture())) {
    assert.deepEqual(value, delta());
    break;
  }
  assert.equal(stopped, true);
});

test('the TypeScript provider contract accepts adapters and rejects invalid requests and events', async () => {
  await execute(process.execPath, [
    require.resolve('typescript/bin/tsc'), '--strict', '--noEmit', '--module', 'NodeNext', 'qa/intelligence-provider-types.cts',
  ], { cwd: path.resolve(__dirname, '..') });
});
