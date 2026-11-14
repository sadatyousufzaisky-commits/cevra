const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { discoverOllama } = require('../src/intelligence/providers/ollama.cjs');
const { createProviderRegistry } = require('../src/intelligence/provider-registry.cjs');
const { modelRoute, profile } = require('../src/intelligence/model-profiles.cjs');
const { createPreferences } = require('../src/preferences.cjs');
const { temporaryFolder } = require('./temp.cjs');
const { ollamaFixture } = require('./ollama-fixture.cjs');

function request(modelId) {
  return { abiVersion: '0.1', requestId: 'qa-route-1', providerId: 'ollama', modelId,
    messages: [{ role: 'user', content: 'Local fixture' }], maxOutputTokens: 1024 };
}

test('Ollama discovers installed models and streams over a real numeric loopback socket', async t => {
  const { state, model, port } = await ollamaFixture(t);
  let admissionChecks = 0;
  const adapter = await discoverOllama(port, new AbortController().signal, () => { admissionChecks++; });
  const registry = createProviderRegistry([adapter]);
  assert.equal(adapter.destination, `http://127.0.0.1:${port}/api/chat`);
  assert.deepEqual(adapter.catalog.models.map(item => item.id), [model]);
  assert.deepEqual(state.requests, [['GET', '/api/status'], ['GET', '/api/tags']]);
  assert.deepEqual(await Array.fromAsync(registry.stream(request(model))), [
    { kind: 'text.delta', requestId: 'qa-route-1', text: 'Local response café 🌱' },
    { kind: 'usage', requestId: 'qa-route-1', inputTokens: 12, outputTokens: 4 },
    { kind: 'complete', requestId: 'qa-route-1', finishReason: 'stop' },
  ]);
  assert.equal(admissionChecks, 1);
  assert.deepEqual(state.chats, [{ body: {
    model, messages: request(model).messages, stream: true, options: { num_predict: 1024 },
  }, authorization: undefined }]);
  state.mode = 'embedding';
  await assert.rejects(Array.fromAsync(registry.stream(request(model))), { code: 'MODEL_UNSUPPORTED' });
  state.mode = 'normal';
  state.digest = 'e'.repeat(64);
  await assert.rejects(Array.fromAsync(registry.stream(request(model))), { code: 'MODEL_UNSUPPORTED' });
  state.cloud = true;
  await assert.rejects(Array.fromAsync(registry.stream(request(model))), { code: 'LOCAL_MODE_REQUIRED' });
  assert.equal(state.chats.length, 1);
});

test('local connection rejects arbitrary destinations and redirects without contacting the redirect target', async t => {
  const { state, port } = await ollamaFixture(t);
  for (const destination of [0, 1023, 65536, '11434', 'http://127.0.0.1', 'https://example.invalid']) {
    await assert.rejects(discoverOllama(destination, new AbortController().signal), { code: 'INVALID_REQUEST' });
  }
  state.mode = 'redirect';
  await assert.rejects(discoverOllama(port, new AbortController().signal), { code: 'NETWORK_BLOCKED' });
  assert.deepEqual(state.requests, [['GET', '/api/status']]);
});

test('Ollama rejects malformed, oversized and remote streams and closes a canceled socket', async t => {
  const { state, model, port } = await ollamaFixture(t);
  const registry = createProviderRegistry([await discoverOllama(port, new AbortController().signal)]);
  for (const mode of ['malformed', 'large', 'remote']) {
    state.mode = mode;
    await assert.rejects(Array.fromAsync(registry.stream(request(model))), { code: 'PROVIDER_PROTOCOL' });
  }
  state.mode = 'stall';
  const stop = new AbortController();
  const events = registry.stream(request(model), { signal: stop.signal });
  assert.match((await events.next()).value.text, /Local response/);
  const pending = events.next();
  stop.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  for (let attempt = 0; attempt < 30 && !state.aborted; attempt++) await delay(20);
  assert.equal(state.aborted, true);
});

test('task routes persist independently and ambiguous model IDs require a provider', async t => {
  const directory = await temporaryFolder(t, 'cevra-model-profile-');
  const preferences = createPreferences(directory);
  assert.deepEqual(await preferences.getIntelligenceModels(), { chat: null, explain: null, patch: null, coding: null });
  const value = {
    chat: { providerId: 'mock', modelId: 'deterministic-v1' },
    explain: { providerId: 'ollama', modelId: 'same' },
    patch: { providerId: 'openai', modelId: 'same' },
    coding: null,
  };
  await preferences.setIntelligenceModels(value);
  assert.deepEqual(await createPreferences(directory).getIntelligenceModels(), value);
  assert.throws(() => profile({ ...value, patch: value.chat }, true), /valid model/);
  assert.throws(() => profile({ ...value, explain: { ...value.explain, url: 'http://example.invalid' } }, true), /valid model/);
  const catalogs = ['openai', 'ollama'].map(providerId => ({ providerId, models: [{ id: 'same' }] }));
  assert.equal(modelRoute(catalogs, undefined, 'same'), null);
  assert.equal(modelRoute(catalogs, 'ollama', 'same').catalog.providerId, 'ollama');
  assert.equal(modelRoute(catalogs.slice(0, 1), 'ollama', 'same'), null);
});
