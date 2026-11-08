const javaScript = new Set(['.js', '.mjs', '.cjs', '.jsx']);
const typeScript = new Set(['.ts', '.mts', '.cts', '.tsx']);

function sourceLanguage(path) {
  const extension = /\.[a-z]+$/i.exec(path)?.[0].toLowerCase();
  const typescript = typeScript.has(extension);
  if (!typescript && !javaScript.has(extension)) return null;
  return {
    extension,
    name: typescript ? 'TypeScript' : 'JavaScript',
    typescript,
    jsx: extension === '.jsx' || extension === '.tsx',
  };
}

module.exports = { sourceLanguage };
