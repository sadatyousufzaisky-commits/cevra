const path = require('node:path');
const { readSource, resolveEntry, workspacePath } = require('./workspace.cjs');

const configName = '.cevra-format.json';
const defaults = { indentStyle: 'spaces', indentWidth: 2, bracketSpacing: true, finalNewline: true, lineEnding: 'preserve' };
const lineEndings = { lf: '\n', crlf: '\r\n', cr: '\r' };

function parseOptions(text, file) {
  let config;
  try {
    config = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(file + ' must contain valid JSON.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(file + ' must contain a formatting options object.');
  }
  for (const key of Object.keys(config)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(file + ' contains an unknown option ' + key + '.');
  }
  const options = { ...defaults, ...config };
  if (!['spaces', 'tabs'].includes(options.indentStyle) ||
      !Number.isInteger(options.indentWidth) || options.indentWidth < 1 || options.indentWidth > 8 ||
      typeof options.bracketSpacing !== 'boolean' || typeof options.finalNewline !== 'boolean' ||
      typeof options.lineEnding !== 'string' ||
      (options.lineEnding !== 'preserve' && !Object.hasOwn(lineEndings, options.lineEnding))) {
    throw new Error(file + ' contains an invalid formatting option.');
  }
  return options;
}

async function readFormatOptions(workspace, relative) {
  const source = path.relative(workspace.root, workspacePath(workspace, relative));
  await resolveEntry(workspace, '');
  let folder = path.dirname(source);
  for (;;) {
    const file = path.join(folder, configName);
    try {
      const { text } = await readSource(workspace, file);
      return parseOptions(text, file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (folder === '.') return defaults;
    folder = path.dirname(folder);
  }
}

module.exports = { readFormatOptions, lineEndings };
