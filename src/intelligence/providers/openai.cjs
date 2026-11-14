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

function directRequest(url, { method, signal, headers, body }) {
  if (debuglog('http').enabled || debuglog('https').enabled ||
      ['http.client.request.start', 'http.client.response.finish'].some(hasSubscribers)) {
    throw new ProviderError('NETWORK_BLOCKED');
  }
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

function createOpenAIProvider(readKey, send = directRequest) {
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
      try {
        signal.throwIfAborted();
        const sent = send(endpoint, {
          method: 'POST', redirect: 'manual', signal,
          headers: { authorization: 'Bearer ' + key.toString('ascii'), 'content-type': 'application/json', accept: 'text/event-stream' },
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
            if (typeof event.delta !== 'string') throw protocolError();
            if (event.delta) {
              textSeen = true;
              yield { kind: 'text.delta', requestId, text: event.delta };
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
          if (result.usage != null) yield {
            kind: 'usage', requestId, inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
          };
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
