const { parentPort } = require('node:worker_threads');
const ts = require('typescript');
const { withSource, diagnosticMessage } = require('./syntax-analysis.cjs');

const issueLimit = 100;

function checkSyntax(extension, text) {
  return withSource(extension, text, (_source, diagnostics) => {
    return {
      issues: diagnostics.slice(0, issueLimit).map(issue => {
        const from = issue.start;
        const { line, character } = issue.file.getLineAndCharacterOfPosition(from);
        return {
          from,
          to: from + (issue.length ?? 0),
          line: line + 1,
          column: character + 1,
          severity: issue.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error',
          code: issue.code,
          message: diagnosticMessage(issue),
        };
      }),
      omitted: Math.max(0, diagnostics.length - issueLimit),
    };
  });
}

parentPort.on('message', ({ id, extension, text }) => {
  try {
    parentPort.postMessage({ id, result: checkSyntax(extension, text) });
  } catch {
    parentPort.postMessage({ id, error: 'Could not check this file’s syntax.' });
  }
});
