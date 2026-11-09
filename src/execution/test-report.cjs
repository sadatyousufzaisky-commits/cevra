const frameLimit = 60_000;
const countFields = ['tests', 'passed', 'failed', 'skipped', 'todo', 'cancelled', 'cached', 'omitted'];

function encodeReport(prefix, event) {
  return prefix + JSON.stringify(event) + '\n';
}

function validReport(event) {
  if (event?.type === 'output') return typeof event.text === 'string' && event.text.length <= 8_000;
  if (event?.type === 'test-summary') {
    return typeof event.success === 'boolean' && event.counts &&
      countFields.every(key => Number.isSafeInteger(event.counts[key]) && event.counts[key] >= 0) &&
      event.counts.cached <= event.counts.passed;
  }
  if (event?.type !== 'test-failure' || typeof event.name !== 'string' || event.name.length > 300 ||
      typeof event.message !== 'string' || event.message.length > 1_000) return false;
  const location = event.location;
  return location === null || (typeof location?.path === 'string' && location.path.length <= 32_767 &&
    Number.isSafeInteger(location.line) && location.line > 0 &&
    Number.isSafeInteger(location.column) && location.column > 0);
}

function createReportDecoder(prefix, publish, output) {
  let pending = '';
  let plain = false;

  function line(text) {
    if (text.startsWith(prefix)) {
      try {
        const event = JSON.parse(text.slice(prefix.length));
        if (validReport(event)) {
          if (event.type === 'output') output(event.text);
          else if (event.type === 'test-summary') publish({
            type: event.type, success: event.success,
            counts: Object.fromEntries(countFields.map(key => [key, event.counts[key]])),
          });
          else {
            const { type, name, message, location } = event;
            publish({ type, name, message, location: location && {
              path: location.path, line: location.line, column: location.column,
            } });
          }
          return;
        }
      } catch {}
    }
    output(text + '\n');
  }

  return {
    write(text) {
      let offset = 0;
      while (offset < text.length) {
        const newline = text.indexOf('\n', offset);
        const segment = newline < 0 ? text.slice(offset) : text.slice(offset, newline);
        if (plain || pending.length + segment.length > frameLimit) {
          output(pending + segment + (newline < 0 ? '' : '\n'));
          pending = '';
          plain = newline < 0;
        } else {
          pending += segment;
          if (newline >= 0) {
            line(pending);
            pending = '';
          }
        }
        if (newline < 0) break;
        offset = newline + 1;
      }
    },
    finish() {
      if (pending) output(pending);
      pending = '';
    },
  };
}

module.exports = { createReportDecoder, encodeReport };
