const { once } = require('node:events');

const maxFrameBytes = 16 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function fields(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function frame(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (!bytes.length || bytes.length > maxFrameBytes) throw new Error('Invalid Vokri frame length.');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}

async function* readFrames(input) {
  const header = Buffer.alloc(4);
  let body;
  let offset = 0;
  for await (const chunk of input) {
    let cursor = 0;
    while (cursor < chunk.length) {
      const target = body ?? header;
      const size = Math.min(target.length - offset, chunk.length - cursor);
      chunk.copy(target, offset, cursor, cursor + size);
      offset += size;
      cursor += size;
      if (offset !== target.length) continue;
      offset = 0;
      if (!body) {
        const length = header.readUInt32LE();
        if (length < 1 || length > maxFrameBytes) throw new Error('Invalid Vokri frame length.');
        body = Buffer.allocUnsafe(length);
      } else {
        const packet = JSON.parse(decoder.decode(body));
        body = undefined;
        yield packet;
      }
    }
  }
  if (offset || body) throw new Error('Truncated Vokri frame.');
}

function serve(input, output, routes, dispose) {
  let last = 0;
  let ended = false;
  let abort;
  const failed = new Promise((_, reject) => { abort = reject; });
  function write(value) {
    if (ended) return false;
    const bytes = frame({ version: 1, ...value });
    if (output.writableLength + bytes.length > maxFrameBytes * 2) {
      abort(new Error('The Vokri output queue reached its limit.'));
      return false;
    }
    return output.write(bytes);
  }
  const notify = (event, data) => {
    try { write({ event, data }); }
    catch (error) { abort(error); }
  };
  async function requests() {
    for await (const packet of readFrames(input)) {
      if (ended) return;
      if (!fields(packet, ['version', 'id', 'operation', 'arguments']) || packet.version !== 1 ||
          !Number.isSafeInteger(packet.id) || packet.id <= last || packet.id > 0x7fffffff ||
          typeof packet.operation !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(packet.operation)) {
        throw new Error('Invalid Vokri request envelope.');
      }
      last = packet.id;
      let reply;
      try {
        if (!Object.hasOwn(routes, packet.operation)) throw Object.assign(new Error('Unknown service operation.'), { code: 'UNKNOWN_OPERATION' });
        const result = await routes[packet.operation](packet.arguments, notify);
        reply = { id: packet.id, ok: true, result };
      } catch (error) {
        const message = typeof error?.message === 'string' ? error.message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512) : '';
        reply = { id: packet.id, ok: false, error: {
          code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'OPERATION_FAILED',
          message: message || 'The operation failed.',
        } };
      }
      if (!write(reply) && !ended) await once(output, 'drain');
    }
  }
  const onError = error => abort(error);
  output.on('error', onError);
  return Promise.race([requests(), failed]).finally(async () => {
    ended = true;
    input.destroy();
    await dispose();
  });
}

module.exports = { fields, frame, readFrames, serve, maxFrameBytes };
