const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { inside } = require('./workspace.cjs');

const nodeFile = /\.(?:js|cjs|mjs)$/i;

function projectLocation(root, file, line, column = 1) {
  if (!file || !Number.isInteger(line) || line < 1) return null;
  if (file.startsWith('file://')) {
    try {
      file = fileURLToPath(file);
    } catch {
      return null;
    }
  }
  if (!path.isAbsolute(file) || !inside(root, file)) return null;
  const relative = path.relative(root, file);
  if (!nodeFile.test(relative) || relative.split(path.sep).includes('node_modules')) return null;
  return { path: relative, line, column };
}

function sourceLocation(root, text) {
  const lines = text.split(/\r?\n/);
  let header = null;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    let value = trimmed;
    if (trimmed.startsWith('at ')) {
      const frame = / \((?=file:\/\/|[a-z]:[\\/]|[\\/])/i.exec(trimmed);
      value = frame && trimmed.endsWith(')')
        ? trimmed.slice(frame.index + 2, -1)
        : trimmed.replace(/^at (?:async )?/, '');
    }
    const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(value);
    if (!match) continue;
    const [, file, row, column] = match;
    const caret = /^\s*\^/.test(lines[index + 2] || '') ? lines[index + 2].indexOf('^') + 1 : 1;
    const location = projectLocation(root, file, Number(row), column ? Number(column) : caret);
    if (!location) continue;
    if (!header) {
      if (column) return location;
      header = location;
    } else if (column && location.path === header.path && location.line === header.line) {
      return location;
    }
  }
  return header;
}

module.exports = { nodeFile, projectLocation, sourceLocation };
