const ts = require('typescript');

const maxNodes = 100_000;

function tokenAt(node, offset) {
  if (offset < node.pos || offset >= node.end) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node;
  return ts.forEachChild(node, child => tokenAt(child, offset));
}

function resolveAlias(checker, symbol) {
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
}

function collectCommonJsReferences(program, file, span, limit) {
  const entries = [];
  if (!span) return { entries, limited: false };
  const source = program.getSourceFile(file);
  const token = source && tokenAt(source, span.start);
  if (!token) return { entries, limited: false };

  const checker = program.getTypeChecker();
  const target = resolveAlias(checker, checker.getSymbolAtLocation(token));
  if (!target?.declarations?.length) return { entries, limited: false };
  let visited = 0;
  for (const script of program.getSourceFiles()) {
    if (script.isDeclarationFile || !script.text.includes('require')) continue;
    function visit(node) {
      if (++visited > maxNodes) return true;
      const property = ts.isStringLiteralLike(node) && ts.isElementAccessExpression(node.parent) &&
        node === node.parent.argumentExpression;
      if (ts.isIdentifier(node) || property) {
        const symbol = checker.getSymbolAtLocation(node);
        if (resolveAlias(checker, symbol) === target) {
          const start = node.getStart(script) + (property ? 1 : 0);
          const length = node.getWidth(script) - (property ? 2 : 0);
          entries.push({
            fileName: script.fileName, textSpan: { start, length },
            isDefinition: Boolean(symbol.declarations?.some(declaration => declaration.name === node)),
          });
          if (entries.length > limit) return true;
        }
      }
      return ts.forEachChild(node, visit);
    }
    if (ts.forEachChild(script, visit)) return { entries, limited: true };
  }
  return { entries, limited: false };
}

module.exports = { collectCommonJsReferences };
