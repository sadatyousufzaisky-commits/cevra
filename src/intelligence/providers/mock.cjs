const { setTimeout: delay } = require('node:timers/promises');
const { providerAbi } = require('../provider-contract.cjs');

const parts = ['This ', 'is ', 'an ', 'offline ', 'mock ', 'response.'];
const mockProvider = {
  catalog: {
    abiVersion: providerAbi,
    providerId: 'mock',
    label: 'Offline mock',
    provenance: 'CEVRA deterministic fixture v1',
    models: [{
      id: 'deterministic-v1', label: 'Deterministic mock', maxInputBytes: 8192, maxOutputTokens: 128,
      streaming: true, toolProposals: false,
    }],
  },
  async *stream(request, signal) {
    const { requestId, maxOutputTokens, messages } = request;
    const chunks = parts.slice(0, maxOutputTokens);
    for (const text of chunks) {
      await delay(120, undefined, { signal });
      yield { kind: 'text.delta', requestId, text };
    }
    const inputBytes = messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0);
    yield { kind: 'usage', requestId, inputTokens: Math.ceil(inputBytes / 4), outputTokens: chunks.length };
    yield { kind: 'complete', requestId, finishReason: chunks.length < parts.length ? 'length' : 'stop' };
  },
};

module.exports = { mockProvider };
