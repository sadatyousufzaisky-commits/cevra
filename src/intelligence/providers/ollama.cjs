const http = require('node:http');
const net = require('node:net');
const { providerAbi, limits, ProviderError } = require('../provider-contract.cjs');

const host = '127.0.0.1';
const defaultPort = 11434;
const routes = Object.freeze({ status: '/api/status', tags: '/api/tags', show: '/api/show', chat: '/api/chat' });
const modelName = /^[a-z0-9][a-z0-9._/-]{0,62}(?::[a-z0-9][a-z0-9._-]{0,31})?$/i;
const digestPattern = /^[a-f0-9]{64}$/;
const endpoint = port => `http://${host}:${port}`;
const protocol = () => new ProviderError('PROVIDER_PROTOCOL');

function open(port, route, signal, payload) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const bytes = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    const request = http.request({
      hostname: host, port, path: routes[route], method: bytes ? 'POST' : 'GET', family: 4, agent: null,
      createConnection(_options, callback) {
        // Wait for the connected socket before handing the request (and its body) to HTTP.
        const socket = net.connect({ host, port, family: 4, signal });
        const failed = error => callback(error);
        socket.once('error', failed);
        socket.once('connect', () => {
          socket.removeListener('error', failed);
          if (socket.remoteAddress !== host || socket.remotePort !== port) {
            socket.destroy();
            callback(new ProviderError('NETWORK_BLOCKED'));
          } else callback(null, socket);
        });
      },
      signal, maxHeaderSize: 16 * 1024, insecureHTTPParser: false,
      headers: bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : undefined,
    }, response => {
      const socket = response.socket;
      if (socket.remoteAddress !== host || socket.remotePort !== port || response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        reject(new ProviderError('NETWORK_BLOCKED'));
      } else if (response.statusCode !== 200) {
        response.destroy();
        reject(new ProviderError(route === 'status' ? 'LOCAL_MODE_REQUIRED' :
          response.statusCode === 404 ? 'MODEL_UNSUPPORTED' : 'PROVIDER_UNAVAILABLE'));
      } else resolve(response);
    });
    request.once('error', reject);
    request.end(bytes);
  });
}

const decoder = new TextDecoder('utf-8', { fatal: true });
function json(bytes) {
  try { return JSON.parse(decoder.decode(bytes)); }
  catch { throw protocol(); }
}

async function metadata(port, route, signal, maxBytes, payload) {
  const response = await open(port, route, signal, payload);
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] ?? '')) throw protocol();
    const parts = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw protocol();
      parts.push(chunk);
    }
    return json(Buffer.concat(parts, bytes));
  } finally { response.destroy(); }
}

function eligibleModels(data) {
  if (!Array.isArray(data?.models)) throw protocol();
  const candidates = new Map();
  const duplicates = new Set();
  for (const item of data.models) {
    const name = item?.model ?? item?.name;
    if (typeof name !== 'string' || name.length > 80 || !modelName.test(name) || name.includes('..') ||
        /(?:[:/_-])cloud(?:$|[:/_-])/i.test(name) || item.remote_host || item.remote_model ||
        typeof item.digest !== 'string' || !digestPattern.test(item.digest) || !Number.isSafeInteger(item.size) || item.size < 1) continue;
    if (candidates.has(name.toLowerCase())) duplicates.add(name.toLowerCase());
    else candidates.set(name.toLowerCase(), { name, digest: item.digest });
  }
  return [...candidates].filter(([name]) => !duplicates.has(name)).map(([, model]) => model);
}

async function installedModels(port, signal) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new ProviderError('INVALID_REQUEST');
  const probe = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const status = await metadata(port, 'status', probe, 4096);
  if (status?.cloud?.disabled !== true || !['env', 'config', 'both'].includes(status.cloud.source)) {
    throw new ProviderError('LOCAL_MODE_REQUIRED');
  }
  return eligibleModels(await metadata(port, 'tags', probe, 512 * 1024));
}

async function* ndjson(response) {
  const frameLimit = 64 * 1024;
  const frame = Buffer.allocUnsafe(frameLimit);
  let length = 0;
  let total = 0;
  let count = 0;
  for await (const chunk of response) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) throw protocol();
    for (let offset = 0; offset < chunk.length;) {
      const end = chunk.indexOf(10, offset);
      const limit = end === -1 ? chunk.length : end;
      const size = limit - offset;
      if (length + size > frameLimit) throw protocol();
      chunk.copy(frame, length, offset, limit);
      length += size;
      if (end === -1) break;
      offset = end + 1;
      if (length) {
        if (++count > limits.events * 2) throw protocol();
        yield json(frame.subarray(0, length));
      }
      length = 0;
    }
  }
  if (length) throw protocol();
}

async function discoverOllama(port, signal, beforeSend) {
  const discovered = (await installedModels(port, signal)).slice(0, limits.models);
  if (!discovered.length) throw new ProviderError('MODEL_UNSUPPORTED');
  const models = new Map(discovered.map(model => [model.name, model.digest]));
  return {
    destination: endpoint(port) + routes.chat,
    catalog: {
      abiVersion: providerAbi, providerId: 'ollama', label: 'Ollama on this computer', provenance: 'Local Ollama model list',
      models: discovered.map(({ name }) => ({ id: name, label: name, streaming: true, toolProposals: false,
        maxInputBytes: limits.inputBytes, maxOutputTokens: 1024 })),
    },
    async *stream(input, signal) {
      const installed = await installedModels(port, signal);
      if (!installed.some(item => item.name === input.modelId && item.digest === models.get(input.modelId))) {
        throw new ProviderError('MODEL_UNSUPPORTED');
      }
      const details = await metadata(port, 'show', AbortSignal.any([signal, AbortSignal.timeout(5000)]), 256 * 1024,
        { model: input.modelId });
      if (!Array.isArray(details?.capabilities) || !details.capabilities.includes('completion') || details.remote_host || details.remote_model) {
        throw new ProviderError('MODEL_UNSUPPORTED');
      }
      await beforeSend?.(signal);
      signal.throwIfAborted();
      const response = await open(port, 'chat', signal, {
        model: input.modelId, messages: input.messages, stream: true, options: { num_predict: input.maxOutputTokens },
      });
      const { requestId } = input;
      try {
        if (!/^application\/x-ndjson(?:\s*;|$)/i.test(response.headers['content-type'] ?? '')) throw protocol();
        for await (const item of ndjson(response)) {
          if (typeof item?.error === 'string') throw new ProviderError('PROVIDER_UNAVAILABLE');
          if (item?.model !== input.modelId || item.remote_host || item.remote_model || typeof item.done !== 'boolean' ||
              item.message?.role !== 'assistant' || typeof item.message.content !== 'string' ||
              item.message.tool_calls?.length) throw protocol();
          if (item.message.content) yield { kind: 'text.delta', requestId, text: item.message.content };
          if (!item.done) continue;
          if (!['stop', 'length'].includes(item.done_reason)) throw protocol();
          if (item.prompt_eval_count !== undefined && item.eval_count !== undefined) yield {
            kind: 'usage', requestId, inputTokens: item.prompt_eval_count, outputTokens: item.eval_count,
          };
          yield { kind: 'complete', requestId, finishReason: item.done_reason };
          return;
        }
        throw protocol();
      } finally { response.destroy(); }
    },
  };
}

module.exports = { discoverOllama, defaultPort };
