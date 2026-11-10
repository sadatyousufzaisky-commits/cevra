const maxMessage = 4 * 1024 * 1024;

function connectInspector(url, onEvent, onClose) {
  const socket = new WebSocket(url);
  const { promise: ready, resolve, reject } = Promise.withResolvers();
  const requests = new Map();
  let sequence = 0;
  let closed = false;

  function fail(error) {
    if (closed) return;
    closed = true;
    reject(error);
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    requests.clear();
    socket.close();
    onClose(error);
  }

  socket.addEventListener('open', () => resolve());
  socket.addEventListener('close', () => fail(new Error('The debugger connection closed.')));
  socket.addEventListener('error', () => fail(new Error('Could not connect to the launched debugger.')));
  socket.addEventListener('message', event => {
    if (closed) return;
    if (typeof event.data !== 'string' || event.data.length > maxMessage) {
      fail(new Error('A debugger response exceeded the size limit.'));
      return;
    }
    let message;
    try { message = JSON.parse(event.data); }
    catch { fail(new Error('The debugger returned an invalid response.')); return; }
    if (Number.isSafeInteger(message?.id)) {
      const request = requests.get(message.id);
      if (!request) return;
      requests.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(String(message.error.message ?? 'Debugger request failed.').slice(0, 300)));
      else request.resolve(message.result);
    } else if (typeof message?.method === 'string') onEvent(message.method, message.params ?? {});
  });

  return {
    ready,
    request(method, params = {}) {
      if (closed || socket.readyState !== WebSocket.OPEN) throw new Error('The debugger is disconnected.');
      if (requests.size >= 32) throw new Error('The debugger has too many outstanding requests.');
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          requests.delete(id);
          reject(new Error('The debugger did not respond in time.'));
        }, 4500);
        requests.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) {
          clearTimeout(timer);
          requests.delete(id);
          reject(error);
        }
      });
    },
    close() { fail(new Error('The debugger connection closed.')); },
  };
}

module.exports = { connectInspector };
