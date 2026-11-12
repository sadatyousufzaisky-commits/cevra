import { createProviderRegistry } from '../src/intelligence/provider-registry.cjs';
import type { ProviderAdapter, ProviderEvent, ProviderRequest } from '../src/intelligence/provider-registry.cjs';

const adapter = {
  catalog: {
    abiVersion: '0.1', providerId: 'fixture', label: 'Fixture', provenance: 'Fixture v1',
    models: [{ id: 'example', label: 'Example', maxInputBytes: 1024, maxOutputTokens: 32, streaming: true, toolProposals: false }],
  },
  async *stream(request) {
    yield { kind: 'complete', requestId: request.requestId, finishReason: 'stop' };
  },
} satisfies ProviderAdapter;

const request = {
  abiVersion: '0.1', requestId: 'test-1', providerId: 'fixture', modelId: 'example',
  messages: [{ role: 'user', content: 'Explain this fixture.' }], maxOutputTokens: 8,
} satisfies ProviderRequest;

createProviderRegistry([adapter]).stream(request, { signal: new AbortController().signal });

// @ts-expect-error Requests cannot carry credentials.
const invalidRequest: ProviderRequest = { ...request, apiKey: 'fixture' };
// @ts-expect-error Usage is a pair of validated token totals.
const invalidUsage: ProviderEvent = { kind: 'usage', requestId: 'test-1', inputTokens: 12 };
// @ts-expect-error G1 events cannot carry an executable tool action.
const invalidTool: ProviderEvent = { kind: 'tool.proposal', requestId: 'test-1', name: 'example' };
