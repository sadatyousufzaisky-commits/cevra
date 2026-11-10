const path = require('node:path');
const { pythonFile } = require('../runtime-kind.cjs');
const { projectLocation, sourceLocation } = require('../source-location.cjs');

const typeScriptSources = /\.(?:js|cjs|mjs|ts|cts|mts)$/i;

function typeScriptDiagnostic(root, text) {
  const location = sourceLocation(root, text, typeScriptSources);
  const summary = /^[A-Za-z]*Error(?: \[[^\]]+\])?: [^\r\n]+/m.exec(text)?.[0];
  return { location, summary };
}

function pythonDiagnostic(root, text) {
  const lines = text.split(/\r?\n/);
  let location;
  let pointer;
  let summary;
  for (const [index, line] of lines.entries()) {
    if (/^(?:Traceback \(most recent call last\):|During handling of the above exception|The above exception was the direct cause)/.test(line)) {
      location = pointer = undefined;
    }
    const frame = /^\s*File "(.+)", line (\d+)(?:, in .*)?$/.exec(line);
    if (frame) {
      const file = frame[1];
      const candidate = projectLocation(root, path.isAbsolute(file) ? file : path.resolve(root, file), Number(frame[2]), 1, pythonFile);
      if (!candidate) continue;
      location = candidate;
      const snippet = lines[index + 1];
      const marker = /^([ \t]*)[~^]+\s*$/.exec(lines[index + 2] ?? '');
      pointer = marker && snippet?.startsWith('    ') ? { text: snippet.slice(4), offset: marker[1].length - 4 } : undefined;
    } else if (/^[A-Za-z_][\w.]*: .+/.test(line)) summary = line;
  }
  return { location, pointer, summary };
}

function pythonColumn(line, pointer) {
  if (!pointer || pointer.offset < 0 || !line || pointer.offset > pointer.text.length) return 1;
  if (line.trimEnd() === pointer.text.trimEnd()) return pointer.offset + 1;
  const trimmed = line.trimStart();
  if (trimmed.trimEnd() === pointer.text.trimEnd()) return line.length - trimmed.length + pointer.offset + 1;
  return 1;
}

module.exports = { pythonColumn, pythonDiagnostic, typeScriptDiagnostic };
