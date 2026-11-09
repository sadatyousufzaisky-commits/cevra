const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const { checkedEntrySync, readSourceSync } = require('./workspace.cjs');
const { collectSourceFiles, sourceFileKey } = require('./source-files.cjs');
const { normalizeSource, sourceLocation } = require('./source-text.cjs');

const maxBytes = 16 * 1024 * 1024;
const maxIndexedSymbols = 24_000;
const maxSymbolsPerFile = 2_000;
const maxResults = 80;
const declarationKinds = new Set([
  'function', 'local function', 'class', 'local class', 'method', 'getter', 'setter', 'accessor',
  'interface', 'type', 'enum', 'enum member', 'module', 'property', 'const', 'let', 'var', 'local var',
]);

function declarations(tree, length) {
  const symbols = [];
  let limited = false;

  function visit(node, container) {
    const { kind, nameSpan, text: name } = node;
    const named = declarationKinds.has(kind) && nameSpan && nameSpan.length > 0 &&
      nameSpan.start >= 0 && nameSpan.start + nameSpan.length <= length;
    if (named) {
      if (symbols.length === maxSymbolsPerFile) {
        limited = true;
        return;
      }
      symbols.push({ name: name.slice(0, 256), kind, container, offset: nameSpan.start, length: nameSpan.length });
    }
    const parent = named ? (container ? container + '.' + name : name).slice(0, 256) : container;
    for (const child of node.childItems ?? []) {
      visit(child, parent);
      if (limited) break;
    }
  }

  for (const child of tree.childItems ?? []) {
    visit(child, '');
    if (limited) break;
  }
  return { symbols, limited };
}

function createSymbolSearch(workspace) {
  let cache = new Map();
  let current;
  const service = ts.createLanguageService({
    getCompilationSettings: () => ({}),
    getCurrentDirectory: () => workspace.root,
    getDefaultLibFileName: () => '',
    getScriptFileNames: () => current ? [current.file] : [],
    getScriptVersion: () => current?.revision ?? '',
    getScriptSnapshot: file => current && sourceFileKey(current.file) === sourceFileKey(file) ? current.snapshot : undefined,
  }, undefined, ts.LanguageServiceMode.Syntactic);

  function search(query, buffers) {
    checkedEntrySync(workspace, '');
    const overlays = new Map(buffers.map(buffer => [sourceFileKey(buffer.file), buffer]));
    const scan = collectSourceFiles(workspace, { overlays: overlays.values() });
    const nextCache = new Map();
    const matches = [];
    const needle = query.toLowerCase();
    let { skipped, limited } = scan;
    let bytes = 0;
    let total = 0;
    for (const absolute of scan.files) {
      const id = sourceFileKey(absolute);
      const relative = path.relative(workspace.root, absolute);
      const draft = overlays.get(id);
      let data;
      try {
        data = draft ? { text: draft.text, revision: createHash('sha256').update(draft.text).digest('hex') } :
          readSourceSync(workspace, relative);
      } catch {
        skipped++;
        continue;
      }
      bytes += Buffer.byteLength(data.text);
      if (bytes > maxBytes || total >= maxIndexedSymbols) {
        limited = true;
        break;
      }
      const text = draft ? data.text : normalizeSource(data.text);
      const revision = (draft ? 'draft:' : 'disk:') + data.revision;
      let entry = cache.get(id);
      if (entry?.revision !== revision) {
        const file = absolute.replaceAll(path.sep, '/');
        current = { file, revision, snapshot: ts.ScriptSnapshot.fromString(text) };
        try {
          entry = { revision, ...declarations(service.getNavigationTree(file), text.length) };
        } finally {
          current = undefined;
        }
      }
      nextCache.set(id, entry);
      const location = draft ? { documentId: draft.documentId, version: draft.version } : { revision: data.revision };
      for (const symbol of entry.symbols) {
        if (total === maxIndexedSymbols) {
          limited = true;
          break;
        }
        total++;
        const name = symbol.name.toLowerCase();
        const index = name.indexOf(needle);
        if (index === -1) continue;
        const rank = symbol.name === query ? 0 : name === needle ? 1 : index === 0 ? 2 : 3;
        matches.push({ rank, text, item: { ...symbol, path: relative, ...location } });
      }
      limited ||= entry.limited;
    }
    cache = nextCache;
    matches.sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name) ||
      a.item.path.localeCompare(b.item.path) || a.item.offset - b.item.offset);
    return {
      items: matches.slice(0, maxResults).map(({ text, item }) => ({ ...item, ...sourceLocation(text, item.offset) })),
      more: matches.length > maxResults, limited, skipped,
    };
  }

  return { search, dispose: () => service.dispose() };
}

module.exports = { createSymbolSearch };
