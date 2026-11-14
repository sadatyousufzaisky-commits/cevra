const https = require('node:https');
const { hasSubscribers } = require('node:diagnostics_channel');
const { urlToHttpOptions } = require('node:url');
const { debuglog } = require('node:util');
const { providerAbi, limits, ProviderError } = require('../provider-contract.cjs');

const endpoint = 'https://api.openai.com/v1/responses';
const modelId = 'gpt-5.6-terra';
const maxWireBytes = 4 * 1024 * 1024;
const maxFrameBytes = 256 * 1024;
const protocolError = () => new ProviderError('PROVIDER_PROTOCOL');
const diagnosticChannels = ['http.client.request.created', 'http.client.request.start',
  'http.client.request.error', 'http.client.response.finish'];

function assertPrivateTransport() {
  if (debuglog('http').enabled || debuglog('https').enabled || diagnosticChannels.some(hasSubscribers)) {
    throw new ProviderError('NETWORK_BLOCKED');
  }
}

function directRequest(url, { method, signal, headers, body }) {
  assertPrivateTransport();
  return new Promise((resolve, reject) => {
    // A dedicated TLS connection bypasses proxy environment settings and follows no redirects.
    const destination = urlToHttpOptions(new URL(url));
    const request = https.request({ ...destination, method, signal, headers, agent: false, rejectUnauthorized: true,
      maxHeaderSize: 16 * 1024, insecureHTTPParser: false }, response => {
      resolve({
        status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, body: response,
        headers: { get: name => response.headers[name] },
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

function credentialGuard(secret) {
  // A trailing prefix stays in main until later text proves it is safe to release.
  const prefix = new Uint16Array(secret.length);
  for (let index = 1, matched = 0; index < secret.length; index++) {
    while (matched && secret[index] !== secret[matched]) matched = prefix[matched - 1];
    if (secret[index] === secret[matched]) matched++;
    prefix[index] = matched;
  }
  let matched = 0;
  return {
    text(delta) {
      const combined = secret.slice(0, matched) + delta;
      for (let index = 0; index < delta.length; index++) {
        while (matched && delta[index] !== secret[matched]) matched = prefix[matched - 1];
        if (delta[index] === secret[matched] && ++matched === secret.length) throw new ProviderError('SENSITIVE_OUTPUT');
      }
      return combined.slice(0, combined.length - matched);
    },
    tail: () => secret.slice(0, matched),
  };
}

function usageEvent(value, input, requestId) {
  const { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: total } = value;
  const cached = value.input_tokens_details?.cached_tokens;
  const reasoning = value.output_tokens_details?.reasoning_tokens;
  const count = (number, max) => Number.isSafeInteger(number) && number >= 0 && number <= max;
  if (!count(inputTokens, 1_050_000) || !count(outputTokens, input.maxOutputTokens) ||
      (total !== undefined && total !== inputTokens + outputTokens) ||
      (cached !== undefined && !count(cached, inputTokens)) ||
      (reasoning !== undefined && !count(reasoning, outputTokens))) throw protocolError();
  return { kind: 'usage', requestId, inputTokens, outputTokens };
}

// Scan bytes before decoding. Delimiters are ASCII and cannot occur inside a UTF-8 code point.
async function* sse(body) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let wireBytes = 0;
  let parts = [];
  let lineBytes = 0;
  let data = [];
  let frameBytes = 0;
  let name;
  let frames = 0;
  let skipLF = false;
  try {
    for await (const chunk of body) {
      wireBytes += chunk.byteLength;
      if (wireBytes > maxWireBytes) throw protocolError();
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let offset = 0;
      while (offset < bytes.length) {
        if (skipLF) {
          skipLF = false;
          if (bytes[offset] === 10 && ++offset === bytes.length) break;
        }
        let end = offset;
        while (end < bytes.length && bytes[end] !== 10 && bytes[end] !== 13) end++;
        const slice = bytes.subarray(offset, end);
        lineBytes += slice.length;
        if (lineBytes > maxFrameBytes) throw protocolError();
        if (slice.length) parts.push(slice);
        if (end === bytes.length) break;
        skipLF = bytes[end] === 13;
        offset = end + 1;
        frameBytes += lineBytes + 1;
        if (frameBytes > maxFrameBytes) throw protocolError();
        const line = decoder.decode(Buffer.concat(parts, lineBytes));
        parts = [];
        lineBytes = 0;
        if (!line) {
          if (data.length) {
            if (++frames > limits.events * 2) throw protocolError();
            const value = JSON.parse(data.join('\n'));
            if (!value || typeof value.type !== 'string' || (name !== undefined && value.type !== name)) throw protocolError();
            yield value;
          }
          data = [];
          name = undefined;
          frameBytes = 0;
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) name = line.slice(6).replace(/^ /, '');
      }
    }
    if (lineBytes || data.length || name !== undefined) throw protocolError();
  } catch (error) {
    if (error instanceof SyntaxError || error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw protocolError();
    throw error;
  }
}

function failure(code, status) {
  if (['insufficient_quota', 'billing_hard_limit_reached', 'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded', 'organization_usage_limit_exceeded'].includes(code)) return ['QUOTA_EXHAUSTED', false];
  if (status === 401 || status === 403 || code === 'invalid_api_key') return ['AUTH_INVALID', false];
  if (status === 404 || code === 'model_not_found') return ['MODEL_UNSUPPORTED', false];
  if (status === 429 || ['rate_limit_exceeded', 'slow_down'].includes(code)) return ['RATE_LIMIT', true];
  if (status >= 300 && status < 400) return ['NETWORK_BLOCKED', false];
  if (status === 408) return ['PROVIDER_TIMEOUT', true];
  if (status === 400 || status === 422 || code === 'invalid_prompt') return ['REQUEST_REJECTED', false];
  return ['PROVIDER_UNAVAILABLE', true];
}

async function rateLimitCode(body) {
  try {
    const parts = [];
    let bytes = 0;
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      if (bytes > 8192) return;
      parts.push(chunk);
    }
    const { error } = JSON.parse(Buffer.concat(parts, bytes).toString('utf8'));
    return error?.code ?? error?.type;
  } catch {}
}

function createOpenAIProvider(readKey, send = directRequest, beforeSend) {
  return {
    catalog: {
      abiVersion: providerAbi, providerId: 'openai', label: 'OpenAI', provenance: 'OpenAI Responses API',
      models: [{ id: modelId, label: 'GPT-5.6 Terra', maxInputBytes: 64 * 1024, maxOutputTokens: 1024,
        streaming: true, toolProposals: false }],
    },
    async *stream(input, signal) {
      const { requestId } = input;
      const errorEvent = ([code, retryable]) => ({ kind: 'error', requestId, code, retryable });
      const key = await readKey(signal);
      let response;
      let guard;
      try {
        signal.throwIfAborted();
        const secret = key.toString('ascii');
        if (!secret || input.messages.some(message => message.content.includes(secret))) throw new ProviderError('SENSITIVE_INPUT');
        guard = credentialGuard(secret);
        if (send === directRequest) assertPrivateTransport();
        if (beforeSend) await beforeSend(input, signal);
        signal.throwIfAborted();
        const sent = send(endpoint, {
          method: 'POST', redirect: 'manual', signal,
          headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            model: input.modelId, input: input.messages, max_output_tokens: input.maxOutputTokens,
            stream: true, store: false, reasoning: { effort: 'none' }, tools: [],
          }),
        });
        key.fill(0);
        response = await sent;
      } finally { key.fill(0); }
      try {
        if (!response.ok) {
          const code = response.status === 429 ? await rateLimitCode(response.body) : undefined;
          yield errorEvent(failure(code, response.status));
          return;
        }
        if (!response.body || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw protocolError();
        let sequence = -1;
        let responseId;
        let textSeen = false;
        for await (const event of sse(response.body)) {
          if (!Number.isSafeInteger(event.sequence_number) || event.sequence_number <= sequence) throw protocolError();
          sequence = event.sequence_number;
          if (event.type === 'error') { yield errorEvent(failure(event.code)); return; }
          if (event.type === 'response.created') {
            if (responseId || typeof event.response?.id !== 'string' || !/^resp_[a-z0-9_]{1,120}$/i.test(event.response.id)) throw protocolError();
            responseId = event.response.id;
            continue;
          }
          if (!responseId || (event.response && event.response.id !== responseId)) throw protocolError();
          if (event.type === 'response.output_item.added' && !['message', 'reasoning'].includes(event.item?.type)) throw protocolError();
          if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
            if (typeof event.delta !== 'string' || !event.delta.isWellFormed() || Buffer.byteLength(event.delta) > limits.deltaBytes) throw protocolError();
            textSeen ||= Boolean(event.delta);
            const visible = guard.text(event.delta);
            if (visible && Buffer.byteLength(visible) <= limits.deltaBytes) {
              yield { kind: 'text.delta', requestId, text: visible };
            } else if (visible) {
              const chars = Array.from(visible);
              // At most 1 Ki characters per event keeps a joined prefix and delta within the ABI byte limit.
              for (let offset = 0; offset < chars.length; offset += 1024) {
                yield { kind: 'text.delta', requestId, text: chars.slice(offset, offset + 1024).join('') };
              }
            }
            continue;
          }
          if (event.type === 'response.failed') {
            if (event.response?.status !== 'failed') throw protocolError();
            yield errorEvent(failure(event.response.error?.code));
            return;
          }
          if (event.type !== 'response.completed' && event.type !== 'response.incomplete') continue;
          const result = event.response;
          const finished = event.type === 'response.completed';
          if (result?.status !== (finished ? 'completed' : 'incomplete')) throw protocolError();
          if (!finished && result.incomplete_details?.reason !== 'max_output_tokens') {
            yield errorEvent(result.incomplete_details?.reason === 'content_filter' ?
              ['CONTENT_FILTERED', false] : ['PROVIDER_UNAVAILABLE', true]);
            return;
          }
          if (!textSeen && finished) throw protocolError();
          const tail = guard.tail();
          if (tail) yield { kind: 'text.delta', requestId, text: tail };
          if (result.usage != null) yield usageEvent(result.usage, input, requestId);
          yield { kind: 'complete', requestId, finishReason: finished ? 'stop' : 'length' };
          return;
        }
        throw protocolError();
      } finally {
        if (typeof response.body?.destroy === 'function') response.body.destroy();
        else { try { await response.body?.cancel(); } catch {} }
      }
    },
  };
}

module.exports = { createOpenAIProvider, endpoint };
