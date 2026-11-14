const providerAbi = '0.1';
const limits = Object.freeze({
  models: 32, messages: 16, inputBytes: 64 * 1024, outputTokens: 8192,
  events: 4096, deltaBytes: 4096, outputBytes: 64 * 1024, deadlineMs: 45_000,
});
const errors = Object.freeze({
  INVALID_REQUEST: 'The Intelligence request is invalid.',
  PROVIDER_UNAVAILABLE: 'The selected provider is unavailable.',
  REQUEST_REJECTED: 'The provider rejected the request.',
  MODEL_UNSUPPORTED: 'The selected model is unavailable from this provider.',
  PROVIDER_PROTOCOL: 'The provider returned an invalid or oversized stream.',
  PROVIDER_TIMEOUT: 'The provider request timed out.',
  CANCELLED: 'Request stopped.',
  AUTH_INVALID: 'The provider rejected the connection.',
  AUTH_EXPIRED: 'The provider connection expired.',
  CONTENT_FILTERED: 'The provider ended the response because of its content policy.',
  CONTEXT_CHANGED: 'The attached source changed. Remove it and attach it again.',
  QUOTA_EXHAUSTED: 'The provider quota is exhausted.',
  RATE_LIMIT: 'The provider rate limit was reached.',
  NETWORK_BLOCKED: 'The provider connection was blocked.',
});
const reportedErrors = new Set([
  'PROVIDER_UNAVAILABLE', 'AUTH_INVALID', 'AUTH_EXPIRED', 'QUOTA_EXHAUSTED', 'RATE_LIMIT', 'NETWORK_BLOCKED',
  'MODEL_UNSUPPORTED', 'CONTENT_FILTERED', 'PROVIDER_TIMEOUT', 'REQUEST_REJECTED',
]);
const roles = new Set(['system', 'user', 'assistant']);
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const modelIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const correlation = /^[A-Za-z0-9-]{1,64}$/;

class ProviderError extends Error {
  constructor(code) {
    super(errors[code]);
    this.name = 'ProviderError';
    this.code = code;
  }
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(fields).length === keys.length &&
    keys.every(key => fields[key]?.enumerable && Object.hasOwn(fields[key], 'value'));
}

function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function matches(value, pattern, max) {
  return typeof value === 'string' && value.length <= max && pattern.test(value);
}

function text(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value.isWellFormed() && !value.includes('\0') && Buffer.byteLength(value) <= max;
}

function label(value, max) {
  return text(value, max) && value.trim().length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function catalog(value) {
  if (!exactRecord(value, ['abiVersion', 'providerId', 'label', 'provenance', 'models']) ||
      value.abiVersion !== providerAbi || !matches(value.providerId, identifier, 64) ||
      !label(value.label, 80) || !label(value.provenance, 120) ||
      !Array.isArray(value.models) || value.models.length < 1 || value.models.length > limits.models) {
    throw new ProviderError('PROVIDER_PROTOCOL');
  }
  const seen = new Set();
  const models = [];
  for (const model of value.models) {
    if (!exactRecord(model, ['id', 'label', 'maxInputBytes', 'maxOutputTokens', 'streaming', 'toolProposals']) ||
        !matches(model.id, modelIdentifier, 128) || seen.has(model.id) || !label(model.label, 80) ||
        !integer(model.maxInputBytes, 1, limits.inputBytes) || !integer(model.maxOutputTokens, 1, limits.outputTokens) ||
        model.streaming !== true || model.toolProposals !== false) {
      throw new ProviderError('PROVIDER_PROTOCOL');
    }
    seen.add(model.id);
    models.push(Object.freeze({ ...model }));
  }
  return Object.freeze({ ...value, models: Object.freeze(models) });
}

function request(value) {
  if (!exactRecord(value, ['abiVersion', 'requestId', 'providerId', 'modelId', 'messages', 'maxOutputTokens']) ||
      value.abiVersion !== providerAbi || !matches(value.requestId, correlation, 64) ||
      !matches(value.providerId, identifier, 64) || !matches(value.modelId, modelIdentifier, 128) ||
      !integer(value.maxOutputTokens, 1, limits.outputTokens) || !Array.isArray(value.messages) ||
      value.messages.length < 1 || value.messages.length > limits.messages) {
    throw new ProviderError('INVALID_REQUEST');
  }
  const messages = [];
  let inputBytes = 0;
  for (const message of value.messages) {
    if (!exactRecord(message, ['role', 'content']) || !roles.has(message.role) || !text(message.content, limits.inputBytes)) {
      throw new ProviderError('INVALID_REQUEST');
    }
    inputBytes += Buffer.byteLength(message.content);
    if (inputBytes > limits.inputBytes) throw new ProviderError('INVALID_REQUEST');
    messages.push(Object.freeze({ ...message }));
  }
  if (messages.at(-1).role !== 'user' || !messages.at(-1).content.trim()) throw new ProviderError('INVALID_REQUEST');
  return { value: Object.freeze({ ...value, messages: Object.freeze(messages) }), inputBytes };
}

function providerEvent(value, input) {
  if (!value || typeof value !== 'object' || typeof value.kind !== 'string' || value.requestId !== input.requestId) {
    throw new ProviderError('PROVIDER_PROTOCOL');
  }
  const base = ['kind', 'requestId'];
  const valid = {
    'text.delta': () => exactRecord(value, [...base, 'text']) && text(value.text, limits.deltaBytes),
    usage: () => exactRecord(value, [...base, 'inputTokens', 'outputTokens']) &&
      integer(value.inputTokens, 0, 1_000_000_000) && integer(value.outputTokens, 0, input.maxOutputTokens),
    error: () => exactRecord(value, [...base, 'code', 'retryable']) && reportedErrors.has(value.code) &&
      typeof value.retryable === 'boolean',
    complete: () => exactRecord(value, [...base, 'finishReason']) && ['stop', 'length'].includes(value.finishReason),
  };
  if (!Object.hasOwn(valid, value.kind) || !valid[value.kind]()) throw new ProviderError('PROVIDER_PROTOCOL');
  return Object.freeze({ ...value });
}

function safeProviderError(error, fallback = 'PROVIDER_UNAVAILABLE') {
  return new ProviderError(error instanceof ProviderError && Object.hasOwn(errors, error.code) ? error.code : fallback);
}

module.exports = { providerAbi, limits, ProviderError, exactRecord, catalog, request, providerEvent, safeProviderError };
