const { parentPort } = require('node:worker_threads');
const ts = require('typescript');

const issueLimit = 100;

function checkSyntax(extension, text) {
  const file = '/cevra/source' + extension;
  const snapshot = ts.ScriptSnapshot.fromString(text);
  const options = {
    allowJs: true,
    noResolve: true,
    noLib: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest,
  };
  // The service sees only the supplied buffer. It has no project filesystem host.
  const host = {
    getScriptFileNames: () => [file],
    getScriptVersion: () => '1',
    getScriptSnapshot: name => name === file ? snapshot : undefined,
    getCurrentDirectory: () => '/cevra',
    getCompilationSettings: () => options,
    getDefaultLibFileName: () => '',
    fileExists: name => name === file,
    readFile: name => name === file ? text : undefined,
  };
  const service = ts.createLanguageService(host);
  try {
    const diagnostics = service.getSyntacticDiagnostics(file)
      .filter(issue => issue.file && issue.start !== undefined);
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
          message: ts.flattenDiagnosticMessageText(issue.messageText, ' '),
        };
      }),
      omitted: Math.max(0, diagnostics.length - issueLimit),
    };
  } finally {
    service.dispose();
  }
}

parentPort.on('message', ({ id, extension, text }) => {
  try {
    parentPort.postMessage({ id, result: checkSyntax(extension, text) });
  } catch {
    parentPort.postMessage({ id, error: 'Could not check this file’s syntax.' });
  }
});
