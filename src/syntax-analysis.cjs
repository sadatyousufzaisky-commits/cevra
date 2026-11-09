const ts = require('typescript');

function withSource(extension, text, inspect) {
  const file = '/cevra/source' + extension;
  const snapshot = ts.ScriptSnapshot.fromString(text);
  const options = {
    allowJs: true,
    noResolve: true,
    noLib: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest,
  };
  // Only the supplied buffer is visible to the language service.
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
    const diagnostics = service.getSyntacticDiagnostics(file).filter(issue => issue.file && issue.start !== undefined);
    return inspect(service.getProgram().getSourceFile(file), diagnostics);
  } finally {
    service.dispose();
  }
}

function diagnosticMessage(issue) {
  return ts.flattenDiagnosticMessageText(issue.messageText, ' ');
}

module.exports = { withSource, diagnosticMessage };
