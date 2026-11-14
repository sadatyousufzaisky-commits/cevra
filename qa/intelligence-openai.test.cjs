const assert = require('node:assert/strict');
const { test } = require('node:test');
const { subscribe, unsubscribe } = require('node:diagnostics_channel');
const { createProviderRegistry } = require('../src/intelligence/provider-registry.cjs');
const { createOpenAIProvider, endpoint } = require('../src/intelligence/providers/openai.cjs');

const responseId = 'resp_qa';
const stream = (...events) => events.map((event, sequence_number) =>
  'event: ' + event.type + '\r\ndata: ' + JSON.stringify({ ...event, sequence_number }) + '\r\n\r\n').join('');
const created = { type: 'response.created', response: { id: responseId } };
const delta = text => ({ type: 'response.output_text.delta', delta: text });
const complete = { type: 'response.completed', response: { id: responseId, status: 'completed',
  usage: { input_tokens: 7, output_tokens: 3 } } };
const request = {
  abiVersion: '0.1', requestId: 'request-1', providerId: 'openai', modelId: 'gpt-5.6-terra',
  messages: [{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Next' }],
  maxOutputTokens: 1024,
};
const response = input => new Response(input, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

function fixture(send) {
  const key = Buffer.from('SYNTHETIC_G3_KEY');
  const registry = createProviderRegistry([createOpenAIProvider(async () => key, send)]);
  return { key, events: options => registry.stream(request, options) };
}

test('the adapter sends only the selected conversation and handles fragmented Unicode SSE and usage', async () => {
  const bytes = Buffer.from(': ping\r\n\r\n' + stream(created, delta('café 🌱'), complete));
  const { key, events } = fixture(async (url, options) => {
    assert.equal(url, endpoint);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, 'Bearer SYNTHETIC_G3_KEY');
    assert.deepEqual(JSON.parse(options.body), {
      model: request.modelId, input: request.messages, max_output_tokens: 1024,
      stream: true, store: false, reasoning: { effort: 'none' }, tools: [],
    });
    let offset = 0;
    return response(new ReadableStream({
      pull(controller) { if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.subarray(offset, ++offset)); },
    }));
  });
  assert.deepEqual(await Array.fromAsync(events()), [
    { kind: 'text.delta', requestId: request.requestId, text: 'café 🌱' },
    { kind: 'usage', requestId: request.requestId, inputTokens: 7, outputTokens: 3 },
    { kind: 'complete', requestId: request.requestId, finishReason: 'stop' },
  ]);
  assert.ok(key.every(value => value === 0));
});

test('OpenAI errors are typed, redact provider text, and never retry or follow a redirect automatically', async () => {
  const cases = [
    [307, {}, 'NETWORK_BLOCKED', false],
    [401, {}, 'AUTH_INVALID', false],
    [404, {}, 'MODEL_UNSUPPORTED', false],
    [429, { code: 'insufficient_quota' }, 'QUOTA_EXHAUSTED', false],
    [429, { code: 'rate_limit_exceeded' }, 'RATE_LIMIT', true],
    [503, {}, 'PROVIDER_UNAVAILABLE', true],
  ];
  for (const [status, error, code, retryable] of cases) {
    let sends = 0;
    const { events } = fixture(async () => {
      sends++;
      return new Response(JSON.stringify({ error: { ...error, message: 'SECRET_PROVIDER_DETAIL' } }), {
        status, headers: { location: 'http://127.0.0.1/' },
      });
    });
    assert.deepEqual(await Array.fromAsync(events()), [{ kind: 'error', requestId: request.requestId, code, retryable }]);
    assert.equal(sends, 1);
  }
});

test('incomplete streams distinguish output limits from provider content filtering', async () => {
  for (const [reason, expected] of [
    ['max_output_tokens', { kind: 'complete', finishReason: 'length' }],
    ['content_filter', { kind: 'error', code: 'CONTENT_FILTERED', retryable: false }],
  ]) {
    const incomplete = { type: 'response.incomplete', response: { id: responseId, status: 'incomplete',
      incomplete_details: { reason } } };
    const { events } = fixture(async () => response(stream(created, delta('Partial'), incomplete)));
    assert.deepEqual((await Array.fromAsync(events())).at(-1), { ...expected, requestId: request.requestId });
  }
});

test('the cloud adapter rejects exact credentials in outgoing text and fragmented provider echoes', async () => {
  const secret = 'SYNTHETIC_G3_KEY';
  const key = Buffer.from(secret);
  const registry = createProviderRegistry([createOpenAIProvider(async () => key, () => assert.fail('unexpected send'))]);
  await assert.rejects(Array.fromAsync(registry.stream({ ...request,
    messages: [{ role: 'user', content: 'User pasted ' + secret }] })), { code: 'SENSITIVE_INPUT' });
  assert.ok(key.every(value => value === 0));

  const { events } = fixture(async () => response(stream(created, delta('Safe SYNTH'), delta('ETIC_G3'), delta('_KEY'))));
  const output = events();
  assert.equal((await output.next()).value.text, 'Safe ');
  await assert.rejects(output.next(), { code: 'SENSITIVE_OUTPUT', message: 'The provider response contained the connection credential. VOKRI Intelligence stopped the response.' });

  const normal = fixture(async () => response(stream(created, delta('A SYNTH'), delta('etic S'), complete)));
  assert.equal((await Array.fromAsync(normal.events())).filter(event => event.kind === 'text.delta').map(event => event.text).join(''), 'A SYNTHetic S');
});

test('OpenAI transport refuses subscribers that could observe a request carrying credentials', async () => {
  for (const channel of ['http.client.request.created', 'http.client.request.start', 'http.client.request.error', 'http.client.response.finish']) {
    const observe = () => assert.fail('private request reached diagnostics');
    subscribe(channel, observe);
    const key = Buffer.from('SYNTHETIC_G3_KEY');
    try {
      const registry = createProviderRegistry([createOpenAIProvider(async () => key)]);
      await assert.rejects(Array.fromAsync(registry.stream(request)), { code: 'NETWORK_BLOCKED' });
      assert.ok(key.every(value => value === 0));
    } finally { unsubscribe(channel, observe); }
  }
});

test('the adapter rejects malformed, repeated, crossed and oversized streams', async () => {
  const packets = [
    new Response('not SSE'),
    response(stream(created, delta('x')).slice(0, -4)),
    response(stream(created, delta('x')) + stream(complete)),
    response(stream(created, { ...complete, response: { ...complete.response, id: 'resp_other' } })),
    response(stream(created, delta('x'), { ...complete, response: { ...complete.response, usage: { input_tokens: 1, output_tokens: 1025 } } })),
    response(stream(created, delta('x'), { ...complete, response: { ...complete.response, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 3 } } })),
    response(stream(created, delta('x'), { ...complete, response: { ...complete.response, usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 2 } } } })),
    response(stream(created, { type: 'response.output_item.added', item: { type: 'function_call' } })),
    response('data: ' + 'x'.repeat(256 * 1024)),
    response(stream(created, ...Array(18).fill(delta('x'.repeat(4000))), complete)),
  ];
  for (const packet of packets) {
    const { events } = fixture(async () => packet);
    await assert.rejects(Array.fromAsync(events()), { code: 'PROVIDER_PROTOCOL' });
  }
});

test('stop and timeout cancel an in-flight OpenAI body and clear its borrowed key', { timeout: 5000 }, async () => {
  for (const mode of ['stop', 'timeout']) {
    const cancelled = Promise.withResolvers();
    const controller = new AbortController();
    const { key, events } = fixture(async (_url, { signal }) => response(new ReadableStream({
      start(body) {
        body.enqueue(Buffer.from(stream(created, delta('Partial'))));
        signal.addEventListener('abort', () => { cancelled.resolve(); body.error(signal.reason); }, { once: true });
      },
    })));
    const reader = events({ signal: controller.signal, deadlineMs: mode === 'timeout' ? 80 : 3000 });
    assert.equal((await reader.next()).value.text, 'Partial');
    const pending = reader.next();
    if (mode === 'stop') controller.abort();
    await assert.rejects(pending, { code: mode === 'stop' ? 'CANCELLED' : 'PROVIDER_TIMEOUT' });
    await cancelled.promise;
    assert.ok(key.every(value => value === 0));
  }
});
