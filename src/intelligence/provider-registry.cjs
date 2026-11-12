const { catalog, limits, ProviderError, providerEvent, request, safeProviderError } = require('./provider-contract.cjs');

function pull(iterator, signal) {
  let abort;
  return new Promise((resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return iterator.next();
    }).then(resolve, reject);
  }).finally(() => signal.removeEventListener('abort', abort));
}

async function* streamEvents(adapter, input, external, deadlineMs) {
  if (external?.aborted) throw new ProviderError('CANCELLED');
  const stop = new AbortController();
  const signal = external ? AbortSignal.any([external, stop.signal]) : stop.signal;
  const timer = setTimeout(() => stop.abort('deadline'), deadlineMs);
  let iterator;
  let terminal;
  let usage = false;
  let bytes = 0;
  try {
    try {
      iterator = adapter(input, signal)?.[Symbol.asyncIterator]?.();
    } catch {
      throw new ProviderError('PROVIDER_UNAVAILABLE');
    }
    if (typeof iterator?.next !== 'function') throw new ProviderError('PROVIDER_PROTOCOL');
    for (let count = 0; count < limits.events; count++) {
      let item;
      try { item = await pull(iterator, signal); }
      catch { throw new ProviderError('PROVIDER_UNAVAILABLE'); }
      signal.throwIfAborted();
      if (!item || typeof item !== 'object' || (item.done !== undefined && item.done !== false)) {
        throw new ProviderError('PROVIDER_PROTOCOL');
      }
      const event = providerEvent(item.value, input);
      if (event.kind === 'complete' || event.kind === 'error') {
        terminal = event;
        break;
      }
      if (usage) throw new ProviderError('PROVIDER_PROTOCOL');
      if (event.kind === 'usage') usage = true;
      else {
        bytes += Buffer.byteLength(event.text);
        if (bytes > limits.outputBytes) throw new ProviderError('PROVIDER_PROTOCOL');
      }
      yield event;
    }
    if (!terminal) throw new ProviderError('PROVIDER_PROTOCOL');
  } catch (error) {
    if (external?.aborted) throw new ProviderError('CANCELLED');
    if (stop.signal.aborted) throw new ProviderError('PROVIDER_TIMEOUT');
    throw safeProviderError(error, 'PROVIDER_PROTOCOL');
  } finally {
    clearTimeout(timer);
    stop.abort();
    // The caller can finish even when a failed adapter never settles its pending pull.
    try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch {}
  }
  yield terminal;
}

function createProviderRegistry(adapters) {
  if (!Array.isArray(adapters)) throw new ProviderError('PROVIDER_PROTOCOL');
  const providers = new Map();
  for (const adapter of adapters) {
    const descriptor = catalog(adapter?.catalog);
    if (providers.has(descriptor.providerId) || typeof adapter.stream !== 'function') {
      throw new ProviderError('PROVIDER_PROTOCOL');
    }
    providers.set(descriptor.providerId, { descriptor, stream: adapter.stream.bind(adapter) });
  }
  const descriptors = Object.freeze([...providers.values()].map(provider => provider.descriptor));
  return Object.freeze({
    list: () => descriptors,
    stream(input, { signal, deadlineMs = limits.deadlineMs } = {}) {
      const { value, inputBytes } = request(input);
      if ((signal !== undefined && !(signal instanceof AbortSignal)) ||
          !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > limits.deadlineMs) {
        throw new ProviderError('INVALID_REQUEST');
      }
      const provider = providers.get(value.providerId);
      if (!provider) throw new ProviderError('PROVIDER_UNAVAILABLE');
      const model = provider.descriptor.models.find(item => item.id === value.modelId);
      if (!model) throw new ProviderError('MODEL_UNSUPPORTED');
      if (inputBytes > model.maxInputBytes || value.maxOutputTokens > model.maxOutputTokens) {
        throw new ProviderError('INVALID_REQUEST');
      }
      return streamEvents(provider.stream, value, signal, deadlineMs);
    },
  });
}

module.exports = { createProviderRegistry };
