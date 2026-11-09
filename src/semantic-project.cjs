const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const { checkedEntrySync, inside, readSourceSync, workspacePath } = require('./workspace.cjs');
const { sourceLanguage } = require('./source-language.cjs');
const { normalizeSource, sourceLocation } = require('./source-text.cjs');
const { collectReferenceFiles } = require('./reference-files.cjs');
const { collectCommonJsReferences } = require('./commonjs-references.cjs');

const libraryDirectory = path.dirname(require.resolve('typescript'));
const maxProbes = 2_048;
const maxProjectBytes = 16 * 1024 * 1024;
const maxDefinitions = 40;
const maxReferences = 400;
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

function shorten(text, limit) {
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

function verifiedDefinition(entry) {
  // The local binding of an unresolved import is not its workspace declaration.
  return !entry.unverified && entry.kind !== ts.ScriptElementKind.alias;
}

function describeReferences(text, locations) {
  let line = 1;
  let start = 0;
  let next = text.indexOf('\n');
  return locations.sort((a, b) => a.offset - b.offset || a.length - b.length).map(location => {
    const { offset } = location;
    while (next !== -1 && next < offset) {
      line++;
      start = next + 1;
      next = text.indexOf('\n', start);
    }
    const from = Math.max(start, offset - 40);
    const end = next === -1 ? text.length : next;
    const to = Math.min(end, from + 140);
    const preview = (from > start ? '…' : '') + text.slice(from, to) + (to < end ? '…' : '');
    return { ...location, line, column: offset - start + 1, preview };
  });
}

function activeSignature(info, position) {
  if (!info) return null;
  const { applicableSpan, selectedItemIndex, argumentIndex, items } = info;
  const item = items[selectedItemIndex];
  if (!item || position < applicableSpan.start || position > applicableSpan.start + applicableSpan.length) return null;

  const display = ts.displayPartsToString;
  const prefix = display(item.prefixDisplayParts);
  const suffix = display(item.suffixDisplayParts);
  const separator = display(item.separatorDisplayParts);
  const labels = item.parameters.map(parameter => display(parameter.displayParts));
  const index = item.isVariadic ? Math.min(argumentIndex, labels.length - 1) : argumentIndex;
  const parameter = item.parameters[index];
  const before = parameter ? prefix + labels.slice(0, index).join(separator) + (index ? separator : '') :
    prefix + labels.join(separator) + suffix;
  const after = parameter ? (index + 1 < labels.length ? separator + labels.slice(index + 1).join(separator) : '') + suffix : '';
  return {
    before: shorten(before, 1_000),
    parameter: shorten(labels[index] ?? '', 500),
    after: shorten(after, 1_000),
    documentation: shorten(display(parameter?.documentation) || display(item.documentation), 1_000),
    overload: selectedItemIndex + 1,
    overloadCount: items.length,
  };
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
      return { options: result, directory };
    }
    if (key(directory) === key(workspace.root)) return { options: defaults, directory };
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
        if (request.bytes > maxProjectBytes) {
          request.limited = true;
        } else {
          const revision = 'disk:' + disk.revision;
          const previous = scripts.get(id);
          source = previous?.revision === revision ? previous : { text: normalizeSource(disk.text), revision };
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
    getScriptFileNames: () => request.roots,
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

  function workspaceSource(file) {
    const relative = path.relative(workspace.root, file);
    if (!sourceLanguage(relative)) return null;
    try {
      workspacePath(workspace, relative);
    } catch {
      return null;
    }
    const source = record(file);
    if (!source) return null;
    const id = key(file);
    const overlay = request.overlays.get(id);
    const revision = overlay ? { documentId: overlay.documentId, version: overlay.version } :
      { revision: source.revision.slice('disk:'.length) };
    return { id, text: source.text, location: { path: relative, ...revision } };
  }

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
    const file = compilerPath(target);
    request = {
      roots: [file], overlays, overlayDirectories, records: new Map(), directories: new Map(),
      options: defaults, bytes: 0, probes: 0, limited: false,
    };
    generation++;
    try {
      const { options, directory } = projectOptions(workspace, target, host.readFile);
      request.options = options;
      const result = analyze(file, current.text, directory);
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

  function signatureHelp(target, position, sources) {
    return query(target, sources, file => activeSignature(service.getSignatureHelpItems(file, position, {
      triggerReason: { kind: 'invoked' },
    }), position));
  }

  function definition(target, position, sources) {
    return query(target, sources, file => {
      const definitions = service.getDefinitionAtPosition(file, position) ?? [];
      const destinations = [];
      const seen = new Set();
      let limited = false;
      for (const entry of definitions) {
        if (!verifiedDefinition(entry)) continue;
        const source = workspaceSource(entry.fileName);
        const { start: offset, length } = entry.textSpan;
        if (!source || offset < 0 || length < 0 || offset + length > source.text.length) continue;
        const span = `${source.id}\0${offset}\0${length}`;
        if (seen.has(span)) continue;
        if (destinations.length === maxDefinitions) {
          limited = true;
          break;
        }
        seen.add(span);
        destinations.push({
          ...source.location, offset, length, ...sourceLocation(source.text, offset), name: shorten(entry.name, 160),
        });
      }
      return { destinations, limited };
    });
  }

  function referenceGroups(file, position, definition) {
    const direct = service.findReferences(file, position) ?? [];
    if (direct.length && direct[0].definition.kind !== ts.ScriptElementKind.alias) return direct;
    const targets = definition?.definitions?.filter(verifiedDefinition) ?? [];
    if (targets.length !== 1 || !workspaceSource(targets[0].fileName)) return direct;

    const target = targets[0];
    const canonical = service.findReferences(target.fileName, target.textSpan.start) ?? [];
    // Querying a renamed import can return only the local binding. Also find the declaring symbol's uses.
    if (direct.length) return [...canonical, ...direct];
    if (!canonical.length) return canonical;
    return [...canonical, { definition: canonical[0].definition, references: [{ fileName: file, textSpan: definition.textSpan }] }];
  }

  function references(target, position, sources) {
    return query(target, sources, (file, _text, scope) => {
      const scan = collectReferenceFiles(workspace, scope, target, request.overlays.values());
      request.roots = scan.files.map(compilerPath);
      const origin = service.getDefinitionAndBoundSpan(file, position);
      const groups = referenceGroups(file, position, origin);
      const commonJs = groups.length ? collectCommonJsReferences(service.getProgram(), file, origin?.textSpan, maxReferences) :
        { entries: [], limited: false };
      if (commonJs.entries.length) groups.push({ definition: groups[0].definition, references: commonJs.entries });
      const matches = new Map();
      let count = 0;
      let resultLimited = false;
      for (const group of groups) {
        for (const entry of group.references) {
          const source = workspaceSource(entry.fileName);
          const { start: offset, length } = entry.textSpan;
          if (!source || offset < 0 || length < 1 || offset + length > source.text.length) continue;
          let bucket = matches.get(source.id);
          if (!bucket) {
            bucket = { source, entries: new Map() };
            matches.set(source.id, bucket);
          }
          const declaration = Boolean(entry.isDefinition || (key(group.definition.fileName) === source.id &&
            group.definition.textSpan.start === offset && group.definition.textSpan.length === length));
          const span = `${offset}:${length}`;
          const existing = bucket.entries.get(span);
          if (existing) {
            existing.declaration ||= declaration;
          } else if (count === maxReferences) {
            resultLimited = true;
            break;
          } else {
            bucket.entries.set(span, { offset, length, declaration });
            count++;
          }
        }
        if (resultLimited) break;
      }
      const files = [...matches.values()].filter(bucket => bucket.entries.size).map(({ source, entries }) => ({
        ...source.location, matches: describeReferences(source.text, [...entries.values()]),
      }));
      files.sort((a, b) => a.path.localeCompare(b.path));
      return {
        files, count, resultLimited, scopeLimited: scan.limited || commonJs.limited,
        scope: path.relative(workspace.root, scope) || '.',
        separateProjects: scan.separateProjects, skipped: scan.skipped + scan.files.filter(candidate => !record(candidate)).length,
        symbol: shorten(groups[0]?.definition.name.replace(/\s+/g, ' ') ?? '', 160),
      };
    });
  }

  return { quickInfo, complete, signatureHelp, definition, references, dispose: () => service.dispose() };
}

module.exports = { createSemanticProject };
