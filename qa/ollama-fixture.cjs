const http = require('node:http');
const { once } = require('node:events');

async function ollamaFixture(t) {
  const state = { cloud: false, requests: [], chats: [], digest: 'a'.repeat(64), mode: 'normal' };
  const model = 'fixture:latest';
  const server = http.createServer(async (request, response) => {
    state.requests.push([request.method, request.url]);
    const json = value => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(value));
    };
    if (request.url === '/api/status') {
      if (state.mode === 'redirect') {
        response.writeHead(307, { location: '/unapproved' }).end();
        return;
      }
      json({ cloud: { disabled: !state.cloud, source: state.cloud ? 'none' : 'env' } });
      return;
    }
    if (request.url === '/api/tags') {
      json({ models: [{ model, digest: state.digest, size: 1234 },
        { model: 'remote:latest', remote_host: 'https://ollama.com', digest: 'b'.repeat(64), size: 1 },
        { model: 'fixture:cloud', digest: 'c'.repeat(64), size: 1 }] });
      return;
    }
    if (request.url === '/api/show') {
      request.resume();
      json({ capabilities: state.mode === 'embedding' ? ['embedding'] : ['completion'] });
      return;
    }
    if (request.url !== '/api/chat') { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const bytes of request) chunks.push(bytes);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    state.chats.push({ body, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/x-ndjson');
    if (state.mode === 'malformed') { response.end('{"done":\n'); return; }
    if (state.mode === 'large') { response.end('a'.repeat(64 * 1024 + 1)); return; }
    const row = (content, extra = {}) => JSON.stringify({
      model, message: { role: 'assistant', content }, done: false, ...extra,
    }) + '\r\n';
    let content = 'Local response café 🌱';
    if (state.mode === 'patch') {
      const context = body.messages.find(item => item.content.startsWith('Workspace material selected'));
      const [source] = JSON.parse(context.content.split('\n').slice(1).join('\n'));
      content = JSON.stringify({ schemaVersion: 1, edits: [{ source: source.source, replacement: 'const updated = true;\n' }] });
    }
    if (state.mode === 'remote') {
      response.end(row(content, { remote_host: 'https://ollama.com' }));
      return;
    }
    const bytes = Buffer.from(row(content));
    const split = bytes.indexOf(0xc3) + 1;
    response.write(bytes.subarray(0, split));
    setImmediate(() => {
      if (response.destroyed) return;
      response.write(bytes.subarray(split));
      if (state.mode === 'stall') {
        response.on('close', () => { state.aborted = true; });
        return;
      }
      response.end(row('', { done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 4 }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { state, model, port: server.address().port };
}

module.exports = { ollamaFixture };
