const ts = require('typescript');
const { withSource, diagnosticMessage } = require('./syntax-analysis.cjs');
const { maxFileBytes } = require('./workspace.cjs');

const K = ts.SyntaxKind;
const opaque = new Set([K.JsxElement, K.JsxSelfClosingElement, K.JsxFragment, K.TemplateExpression]);
const commentKinds = new Set([K.SingleLineCommentTrivia, K.MultiLineCommentTrivia, K.ShebangTrivia, K.ConflictMarkerTrivia]);
const blockKinds = new Set([K.Block, K.ModuleBlock, K.ClassDeclaration, K.ClassExpression, K.InterfaceDeclaration,
  K.EnumDeclaration, K.CaseBlock]);
const matchingOpen = new Map([[K.CloseBraceToken, K.OpenBraceToken], [K.CloseBracketToken, K.OpenBracketToken],
  [K.CloseParenToken, K.OpenParenToken]]);
const opening = new Set(matchingOpen.values());
const tightBefore = new Set([K.CommaToken, K.SemicolonToken, K.CloseParenToken, K.CloseBracketToken,
  K.DotToken, K.QuestionDotToken]);
const tightAfter = new Set([K.OpenParenToken, K.OpenBracketToken, K.DotToken, K.QuestionDotToken]);
const keywordsBeforeParen = new Set([K.IfKeyword, K.ForKeyword, K.WhileKeyword, K.SwitchKeyword, K.CatchKeyword,
  K.WithKeyword, K.ReturnKeyword, K.ThrowKeyword, K.AsyncKeyword, K.AwaitKeyword, K.YieldKeyword, K.FunctionKeyword,
  K.NewKeyword]);
const wordsAfterBlock = new Set([K.ElseKeyword, K.CatchKeyword, K.FinallyKeyword, K.WhileKeyword]);
const spaceOperators = new Set([K.EqualsToken, K.EqualsGreaterThanToken, K.AsKeyword, K.SatisfiesKeyword]);
const horizontalOrNewline = /^[ \t\n]*$/;

function collectTokens(source) {
  const tokens = [];
  const starts = new Set();
  const stack = [source];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false);
  let end = 0;

  function collectComments(to) {
    if (to === end || horizontalOrNewline.test(source.text.slice(end, to))) return;
    scanner.setText(source.text, end, to - end);
    for (let kind = scanner.scan(); kind !== K.EndOfFileToken; kind = scanner.scan()) {
      if (commentKinds.has(kind)) {
        tokens.push({ kind, from: scanner.getTokenStart(), to: scanner.getTokenEnd(), comment: true });
      }
    }
  }

  while (stack.length) {
    const node = stack.pop();
    if (node.kind === K.EndOfFileToken || node.kind === K.JSDocComment) continue;
    if (node.statements) {
      for (let i = 1; i < node.statements.length; i++) starts.add(node.statements[i].getStart(source));
    }
    const children = opaque.has(node.kind) ? [] : node.getChildren(source);
    if (children.length) {
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    } else {
      const from = node.getStart(source);
      if (node.end <= from || from < end) continue;
      collectComments(from);
      tokens.push({ kind: node.kind, owner: node.parent?.kind, from, to: node.end });
      end = node.end;
    }
  }
  collectComments(source.text.length);
  return { tokens, starts };
}

function isOperator(token) {
  return spaceOperators.has(token.kind) ||
    (token.owner === K.BinaryExpression && token.kind >= K.FirstBinaryOperator && token.kind <= K.LastBinaryOperator) ||
    (token.owner === K.ConditionalExpression && (token.kind === K.QuestionToken || token.kind === K.ColonToken));
}

function inlineGap(previous, current, gap, options, starts) {
  if (!previous) return '';
  if (previous.comment || current.comment) return gap;
  const a = previous.kind;
  const b = current.kind;
  if (a === K.OpenBraceToken && b === K.CloseBraceToken) return '';
  if ((a === K.OpenBraceToken && blockKinds.has(previous.owner)) ||
      (b === K.CloseBraceToken && blockKinds.has(current.owner)) ||
      (b !== K.SemicolonToken && starts.has(current.from))) return '\n';
  if (b === K.DotToken && a === K.NumericLiteral) return gap;
  if (tightBefore.has(b) || tightAfter.has(a)) return '';
  if (isOperator(previous) || isOperator(current)) return ' ';
  if (b === K.ColonToken) return '';
  if (a === K.ColonToken || a === K.CommaToken || a === K.SemicolonToken) return ' ';
  if (a === K.OpenBraceToken || b === K.CloseBraceToken) return options.bracketSpacing ? ' ' : '';
  if (b === K.OpenBraceToken && (blockKinds.has(current.owner) || a === K.ReturnKeyword || a === K.ThrowKeyword)) return ' ';
  if (a === K.CloseBraceToken && wordsAfterBlock.has(b)) return ' ';
  if (b === K.OpenParenToken) return keywordsBeforeParen.has(a) ? ' ' : '';
  return gap ? ' ' : '';
}

function spacingEdits(source, options) {
  const { tokens, starts } = collectTokens(source);
  const text = source.text;
  const edits = [];
  const stack = [];
  const unit = options.indentStyle === 'tabs' ? '\t' : ' '.repeat(options.indentWidth);
  let previous;
  let length = text.length;

  function change(from, to, insert) {
    if (text.slice(from, to) === insert) return;
    length += insert.length - (to - from);
    if (length > maxFileBytes || edits.length >= 100_000) throw new Error('The formatted document exceeds the size limit.');
    edits.push({ from, to, insert });
  }

  for (const token of tokens) {
    const from = previous?.to ?? 0;
    const gap = text.slice(from, token.from);
    if (matchingOpen.get(token.kind) === stack.at(-1) && matchingOpen.has(token.kind)) stack.pop();
    if (horizontalOrNewline.test(gap)) {
      const breaks = gap.match(/\n/g)?.length ?? 0;
      const spacing = breaks ? '\n'.repeat(breaks) : inlineGap(previous, token, gap, options, starts);
      const indent = spacing.endsWith('\n') ? unit.repeat(Math.min(stack.length, 128)) : '';
      change(from, token.from, spacing + indent);
    }
    if (opening.has(token.kind)) stack.push(token.kind);
    previous = token;
  }
  const end = previous?.to ?? 0;
  if (horizontalOrNewline.test(text.slice(end))) change(end, text.length, previous && options.finalNewline ? '\n' : '');
  return edits;
}

function sameTree(left, right) {
  const stack = [[left, right]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (a.kind !== b.kind) return false;
    const aChildren = a.getChildren(left);
    const bChildren = b.getChildren(right);
    if (aChildren.length !== bChildren.length) return false;
    if (aChildren.length) {
      for (let i = aChildren.length - 1; i >= 0; i--) stack.push([aChildren[i], bChildren[i]]);
    } else if (a.kind !== K.SyntaxList && a.kind !== K.EndOfFileToken && a.getText(left) !== b.getText(right)) {
      return false;
    }
  }
  return true;
}

function checkSize(text, eol, bom) {
  if (Buffer.byteLength(text.replaceAll('\n', eol)) + (bom ? 3 : 0) > maxFileBytes) {
    throw new Error('The formatted document exceeds the size limit.');
  }
}

function formatSource(extension, text, options, eol = '\n', bom = false) {
  return withSource(extension, text, (source, diagnostics) => {
    if (diagnostics.length) throw new Error('Fix the syntax error first. ' + diagnosticMessage(diagnostics[0]));
    const edits = spacingEdits(source, options);
    if (!edits.length) {
      checkSize(text, eol, bom);
      return edits;
    }
    const parts = [];
    let position = 0;
    for (const { from, to, insert } of edits) {
      parts.push(text.slice(position, from), insert);
      position = to;
    }
    parts.push(text.slice(position));
    const formatted = parts.join('');
    checkSize(formatted, eol, bom);
    withSource(extension, formatted, (result, issues) => {
      if (issues.length || !sameTree(source, result)) throw new Error('CEVRA could not apply these spacing changes safely.');
    });
    return edits;
  });
}

module.exports = { formatSource };
