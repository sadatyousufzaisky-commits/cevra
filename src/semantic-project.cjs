const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const { checkedEntrySync, inside, readSourceSync } = require('./workspace.cjs');
const { sourceLanguage } = require('./source-language.cjs');

const libraryDirectory = path.dirname(require.resolve('typescript'));
const maxProbes = 2_048;
const maxProjectBytes = 16 * 1024 * 1024;
const windows = process.platform === 'win32';
const supportedOptions = new Set([
  'target', 'module', 'moduleResolution', 'jsx', 'strict', 'strictNullChecks', 'noImplicitAny', 'paths',
  'baseUrl', 'lib', 'resolveJsonModule', 'exactOptionalPropertyTypes', 'noUncheckedIndexedAccess',
  'customConditions', 'moduleSuffixes', 'verbatimModuleSyntax',
]);
const defaults = {
  allowJs: true, noEmit: true, types: [],
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve, lib: ['lib.es2022.d.ts'],
};

function key(file) {
  const normalized = path.normalize(file);
  return windows ? normalized.toLowerCase() : normalized;
}

function compilerPath(file) {
  return file.replaceAll(path.sep, '/');
}

function completionRange(span, position, length) {
  if (!span) return { from: position, to: position };
  const { start, length: width } = span;
  const end = start + width;
  return start >= 0 && start <= position && position <= end && end <= length ? { from: start, to: end } : null;
}

function completionOptions(info, position, text) {
  if (!info) return null;
  const range = completionRange(info.optionalReplacementSpan, position, text.length);
  if (!range) return null;
  const prefix = text.slice(range.from, position);
  if (prefix.length > 256) return null;
  const foldedPrefix = prefix.toLowerCase();
  const matches = [];
  for (const entry of info.entries) {
    if (entry.hasAction || entry.isSnippet || entry.isFromUncheckedFile ||
        entry.kind === 'directory' || entry.kind === 'external module name') continue;
    const insert = entry.insertText ?? entry.name;
    if (!entry.name || entry.name.length > 256 || !insert || insert.length > 512) continue;
    const filter = entry.filterText ?? entry.name;
    const offset = filter.toLowerCase().indexOf(foldedPrefix);
    if (offset < 0) continue;
    const edit = entry.replacementSpan ? completionRange(entry.replacementSpan, position, text.length) : range;
    if (!edit) continue;
    const rank = filter.startsWith(prefix) ? 0 : offset === 0 ? 1 : 2;
    matches.push({ rank, sort: entry.sortText, option: { label: entry.name, kind: entry.kind, insert, ...edit } });
  }
  matches.sort((a, b) => a.rank - b.rank || a.sort.localeCompare(b.sort) || a.option.label.localeCompare(b.option.label));
  const options = new Map();
  for (const { option } of matches) {
    if (!options.has(option.label)) options.set(option.label, option);
    if (options.size === 80) break;
  }
  return { ...range, global: info.isGlobalCompletion, options: [...options.values()] };
}

function projectOptions(workspace, target, readFile) {
  let directory = path.dirname(target);
  for (;;) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const file = path.join(directory, name);
      const text = readFile(file);
      if (text === undefined) continue;
      const relative = path.relative(workspace.root, file);
      const parsed = ts.parseConfigFileTextToJson(compilerPath(file), text);
      if (parsed.error || !parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
        throw new Error('Check the JSON in ' + relative + '.');
      }
      const compilerOptions = parsed.config.compilerOptions;
      if (compilerOptions !== undefined &&
          (!compilerOptions || typeof compilerOptions !== 'object' || Array.isArray(compilerOptions))) {
        throw new Error('Check the compiler options in ' + relative + '.');
      }
      const data = Object.fromEntries(Object.entries(compilerOptions ?? {})
        .filter(([name]) => supportedOptions.has(name)));
      const { options, errors } = ts.convertCompilerOptionsFromJson(data, compilerPath(directory));
      if (errors.length) throw new Error('Check the compiler options in ' + relative + '.');
      const result = { ...defaults, ...options };
      if (options.target !== undefined && options.lib === undefined) delete result.lib;
      if (options.paths && !options.baseUrl) result.baseUrl = compilerPath(directory);
      if (options.moduleResolution === undefined) {
        if (options.module === ts.ModuleKind.NodeNext) result.moduleResolution = ts.ModuleResolutionKind.NodeNext;
        if (options.module === ts.ModuleKind.Node16) result.moduleResolution = ts.ModuleResolutionKind.Node16;
        if (options.module === ts.ModuleKind.CommonJS) result.moduleResolution = ts.ModuleResolutionKind.Node10;
      } else if (options.module === undefined) {
        if (options.moduleResolution === ts.ModuleResolutionKind.NodeNext) result.module = ts.ModuleKind.NodeNext;
        if (options.moduleResolution === ts.ModuleResolutionKind.Node16) result.module = ts.ModuleKind.Node16;
      }
      return result;
    }
    if (key(directory) === key(workspace.root)) return defaults;
    directory = path.dirname(directory);
  }
}

function createSemanticProject(workspace) {
  const libraries = new Map();
  let scripts = new Map();
  let request;
  let generation = 0;

  function library(file) {
    if (key(path.dirname(file)) !== key(libraryDirectory) || !/^lib\.[a-z0-9.]+\.d\.ts$/i.test(path.basename(file))) {
      return undefined;
    }
    const id = key(file);
    if (!libraries.has(id)) {
      try {
        const resolved = fs.realpathSync.native(file);
        if (key(resolved) !== id) return undefined;
        const text = fs.readFileSync(resolved, 'utf8');
        libraries.set(id, { text, revision: id, snapshot: ts.ScriptSnapshot.fromString(text) });
      } catch {
        libraries.set(id, undefined);
      }
    }
    return libraries.get(id);
  }

  function probe() {
    if (++request.probes <= maxProbes && request.bytes <= maxProjectBytes) return true;
    request.limited = true;
    return false;
  }

  function record(name) {
    const file = path.resolve(workspace.root, name);
    const bundled = library(file);
    if (bundled || !inside(workspace.root, file)) return bundled;
    if (!sourceLanguage(file) && !/\.json$/i.test(file)) return undefined;
    const id = key(file);
    if (request.records.has(id)) return request.records.get(id);
    const overlay = request.overlays.get(id);
    let source;
    if (overlay) {
      const previous = scripts.get(id);
      const stamp = 'buffer:' + overlay.documentId + ':' + overlay.version + ':';
      if (previous?.revision.startsWith(stamp) && previous.text === overlay.text) {
        source = previous;
      } else {
        const digest = createHash('sha256').update(overlay.text).digest('hex');
        source = { text: overlay.text, revision: stamp + digest };
      }
    } else if (probe()) {
      try {
        const disk = readSourceSync(workspace, path.relative(workspace.root, file));
        request.bytes += Buffer.byteLength(disk.text);
        source = { text: disk.text, revision: 'disk:' + disk.revision };
        if (request.bytes > maxProjectBytes) {
          request.limited = true;
          source = undefined;
        }
      } catch {
        source = undefined;
      }
    }
    if (source) {
      const previous = scripts.get(id);
      source = previous?.revision === source.revision ? previous :
        { ...source, snapshot: ts.ScriptSnapshot.fromString(source.text) };
    }
    request.records.set(id, source);
    return source;
  }

  function directoryExists(name) {
    const folder = path.resolve(workspace.root, name);
    const id = key(folder);
    if (id === key(libraryDirectory)) return true;
    if (!inside(workspace.root, folder)) return false;
    if (request.overlayDirectories.has(id)) return true;
    if (request.directories.has(id)) return request.directories.get(id);
    let exists = false;
    if (probe()) {
      try {
        exists = checkedEntrySync(workspace, path.relative(workspace.root, folder)).stat.isDirectory();
      } catch {}
    }
    request.directories.set(id, exists);
    return exists;
  }

  const host = {
    getCurrentDirectory: () => compilerPath(workspace.root),
    getCompilationSettings: () => request.options,
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    getScriptFileNames: () => [request.target],
    getProjectVersion: () => String(generation),
    getScriptVersion: file => record(file)?.revision ?? '',
    getScriptSnapshot: file => record(file)?.snapshot,
    fileExists: file => Boolean(record(file)),
    readFile: file => record(file)?.text,
    directoryExists,
    useCaseSensitiveFileNames: () => !windows,
    // A dependency may have been created, removed, or replaced since the previous request.
    hasInvalidatedResolutions: () => true,
  };
  const service = ts.createLanguageService(host);

  function query(target, sources, analyze) {
    checkedEntrySync(workspace, '');
    const overlays = new Map(sources.map(source => [key(source.file), source]));
    const current = sources.find(source => source.file === target);
    overlays.set(key(target), current);
    const overlayDirectories = new Set();
    for (const source of overlays.values()) {
      let directory = path.dirname(source.file);
      while (inside(workspace.root, directory) && !overlayDirectories.has(key(directory))) {
        overlayDirectories.add(key(directory));
        if (key(directory) === key(workspace.root)) break;
        directory = path.dirname(directory);
      }
    }
    request = {
      target: compilerPath(target), overlays, overlayDirectories, records: new Map(), directories: new Map(),
      options: defaults, bytes: 0, probes: 0, limited: false,
    };
    generation++;
    try {
      request.options = projectOptions(workspace, target, host.readFile);
      const result = analyze(request.target, current.text);
      if (request.limited) throw new Error('This import graph exceeds CEVRA’s analysis limit.');
      return result;
    } finally {
      scripts = request.records;
      request = undefined;
    }
  }

  function quickInfo(target, position, sources) {
    return query(target, sources, file => {
      const info = service.getQuickInfoAtPosition(file, position);
      if (!info) return null;
      if (info.kind === 'alias') {
        const definitions = service.getDefinitionAtPosition(file, position);
        if (!definitions?.some(definition => definition.kind !== 'alias' || key(definition.fileName) !== key(target))) {
          return null;
        }
      }
      return {
        from: info.textSpan.start,
        to: info.textSpan.start + info.textSpan.length,
        signature: ts.displayPartsToString(info.displayParts).slice(0, 2_000),
        documentation: ts.displayPartsToString(info.documentation).slice(0, 2_000),
      };
    });
  }

  function complete(target, position, sources) {
    return query(target, sources, (file, text) => {
      const info = service.getCompletionsAtPosition(file, position, {
        includeCompletionsWithInsertText: true,
        includeCompletionsForModuleExports: false,
        includeCompletionsForImportStatements: false,
      });
      return completionOptions(info, position, text);
    });
  }

  return { quickInfo, complete, dispose: () => service.dispose() };
}

module.exports = { createSemanticProject };
