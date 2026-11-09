const path = require('node:path');
const { inspect, stripVTControlCharacters } = require('node:util');
const { projectLocation, sourceLocation } = require('./source-location.cjs');
const { encodeReport } = require('./execution/test-report.cjs');

const maxFailures = 100;
const maxDetails = 8_000;

module.exports = async function* report(source) {
  const root = process.cwd();
  const prefix = process.env.CEVRA_TEST_REPORT_PREFIX;
  const encode = event => encodeReport(prefix, event);
  function* output(text) {
    for (let start = 0; start < text.length; start += maxDetails) {
      yield encode({ type: 'output', text: text.slice(start, start + maxDetails) });
    }
  }
  const stderrByFile = new Map();
  let reported = 0;
  let cached = 0;

  for await (const { type, data } of source) {
    if (type === 'test:stdout' || type === 'test:stderr') {
      if (type === 'test:stderr') {
        const file = path.resolve(root, data.entryFile ?? data.file);
        const stderr = stderrByFile.get(file) ?? '';
        if (!stderrByFile.has(file) && stderrByFile.size >= 128) stderrByFile.delete(stderrByFile.keys().next().value);
        stderrByFile.set(file, (stderr + data.message).slice(-maxDetails));
      }
      yield* output(data.message);
    } else if (type === 'test:diagnostic' && data.file) {
      yield* output(data.message + '\n');
    } else if (type === 'test:pass') {
      if (!data.todo && !data.skip && data.details.type === 'test' &&
          data.details.passed_on_attempt < data.details.attempt) cached++;
    } else if (type === 'test:fail') {
      const error = data.details.error;
      if (data.todo || error?.failureType === 'subtestsFailed') continue;
      const cause = error?.cause;
      const detail = typeof cause?.stack === 'string' ? stripVTControlCharacters(cause.stack).slice(0, maxDetails) : '';
      const file = data.entryFile ?? data.file;
      const stderr = stripVTControlCharacters(file ? stderrByFile.get(path.resolve(root, file)) ?? '' : '');
      const stderrLocation = !detail && sourceLocation(root, stderr);
      const location = sourceLocation(root, detail) || stderrLocation ||
        projectLocation(root, data.file, data.line, data.column);
      const stderrMessage = stderrLocation ? /^[A-Za-z]*Error(?: \[[^\]]+\])?: [^\r\n]+/m.exec(stderr)?.[0] : undefined;
      const message = cause?.message ?? stderrMessage ??
        (cause !== undefined ? inspect(cause, { depth: 1 }) : error?.message ?? 'Test failed');
      const name = (data.classname ? data.classname + ' › ' + data.name : data.name).slice(0, 300);
      if (++reported <= maxFailures) {
        yield encode({ type: 'test-failure', name, location, message: String(message).slice(0, 1_000) });
      }
      yield* output('\nFAIL ' + name + '\n' + (detail || String(message).slice(0, maxDetails)) + '\n');
    } else if (type === 'test:summary') {
      if (data.file) stderrByFile.delete(path.resolve(root, data.entryFile ?? data.file));
      else yield encode({
        type: 'test-summary',
        counts: { ...data.counts, cached, omitted: Math.max(0, reported - maxFailures) },
        success: data.success,
      });
    }
  }
};
