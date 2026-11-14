const artwork = {
  file: ['neutral', 'M4 1.75h5l3 3v9.5H4z M9 2v3h3', 'M6.25 8h3.5 M6.25 10.5h3.5'],
  javascript: ['amber', 'M2 9h5L5 14l9-7H9l2-5z', 'M2 5h3 M11 12h3'],
  typescript: ['blue', 'M8 1.75 14 5v6l-6 3.25L2 11V5z', 'M5 6.25h6 M8 6.5v4.25'],
  declaration: ['blue', 'M5 2h6v12H5 M2 4v8', 'M7 6h2 M7 9h2'],
  react: ['cyan', 'M2 8l6-5.5L14 8l-6 5.5z M8 3v10', 'M5.25 8h5.5'],
  tsx: ['blue', 'M2 8l6-5.5L14 8l-6 5.5z', 'M5.25 6.5h5.5 M8 6.75v3.75'],
  python: ['blue', 'M3 7V4l2-2h5v5H6v3 M13 9v3l-2 2H6V9h4V6', 'M6 4.5h.1 M10 11.5h.1'],
  html: ['coral', 'M5 4.5 2 8l3 3.5 M11 4.5 14 8l-3 3.5', 'm9.25 3-2.5 10'],
  css: ['iris', 'M2 5h12 M2 11h12', 'M5 2v6 M11 8v6 M4 7l1 1 1-1 M10 9l1-1 1 1'],
  json: ['amber', 'M6 2.5H4.5v4L3 8l1.5 1.5v4H6 M10 2.5h1.5v4L13 8l-1.5 1.5v4H10', 'M8 6v.1 M8 10v.1'],
  markdown: ['iris', 'M2 11V5l3 3 3-3v6', 'M12 5v6 M10 9l2 2 2-2'],
  shell: ['iris', 'M2 3h12v10H2z', 'm4.5 6 2.5 2-2.5 2 M9 10h2.5'],
  config: ['neutral', 'M2 4h12 M2 8h12 M2 12h12', 'M5 2.5v3 M10 6.5v3 M7 10.5v3'],
  package: ['iris', 'M8 2 14 5.5v5L8 14l-6-3.5v-5z M2 5.5 8 9l6-3.5 M8 9v5', 'M5 3.75 11 7.25'],
  yaml: ['iris', 'M4 2v12 M4 5h5 M4 11h5', 'M9 3h4v4H9z M9 9h4v4H9z'],
  database: ['cyan', 'M2.5 4.5C2.5 1.5 13.5 1.5 13.5 4.5v7c0 3-11 3-11 0z', 'M2.5 4.5c0 3 11 3 11 0 M2.5 8c0 3 11 3 11 0'],
  table: ['cyan', 'M2 3h12v10H2z M2 6.5h12', 'M2 10h12 M7 6.5V13'],
  rust: ['coral', 'm8 1.75 5.5 3v6.5l-5.5 3-5.5-3v-6.5z', 'M6 11V5h3l1.25 1.5L9 8H6 M8.5 8l1.75 3'],
  go: ['cyan', 'M13.5 5.25a3.5 3.5 0 1 0 0 5.5V8.5H11', 'M2 6h3 M1.5 9h3.5 M3 12h2.5'],
  c: ['blue', 'M8 2 13.75 5.25v5.5L8 14l-5.75-3.25v-5.5z', 'M10 5.75H6l-1 1v2.5l1 1h4'],
  cpp: ['blue', 'M6.5 4.5H4L2 6.5v3l2 2h2.5', 'M8 8h3 M9.5 6.5v3 M12 8h3 M13.5 6.5v3'],
  csharp: ['iris', 'M6.5 4.5H4L2 6.5v3l2 2h2.5', 'M8.5 6.25h6 M8 9.75h6 M11 4.75l-1.5 6.5 M14 4.75l-1.5 6.5'],
  java: ['coral', 'M3 8h8v2a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z M11 8h2a1.25 1.25 0 0 1 0 2.5h-2', 'M6 6c-2-1 2-2 0-4 M9 6c-1.5-1 1.5-2 0-3.5'],
  image: ['iris', 'M2 3h12v10H2z', 'm3 11 3-4 2 2 2-2 3 4 M10 5.25h.1'],
  archive: ['amber', 'M2 3h12v3H2z M3.5 6v7h9V6', 'M6.5 9h3'],
};

const namedIcons = new Map([
  ['package.json', 'package'], ['package-lock.json', 'package'], ['cargo.toml', 'package'],
  ['pyproject.toml', 'package'], ['dockerfile', 'package'], ['containerfile', 'package'],
  ['makefile', 'config'], ['cmakelists.txt', 'config'], ['.gitignore', 'config'],
  ['.gitattributes', 'config'], ['.editorconfig', 'config'], ['readme', 'markdown'],
]);

const suffixIcons = new Map(Object.entries({
  javascript: ['js', 'mjs', 'cjs'],
  typescript: ['ts', 'mts', 'cts'],
  react: ['jsx'],
  tsx: ['tsx'],
  python: ['py', 'pyw', 'pyi'],
  html: ['html', 'htm', 'xml', 'xhtml'],
  css: ['css', 'scss', 'sass', 'less'],
  json: ['json', 'jsonc', 'json5', 'ndjson'],
  markdown: ['md', 'markdown', 'mdx', 'rst'],
  shell: ['sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'cmd', 'bat'],
  config: ['conf', 'cfg', 'ini', 'toml', 'env'],
  yaml: ['yaml', 'yml'],
  database: ['sql', 'sqlite', 'db'],
  table: ['csv', 'tsv'],
  rust: ['rs'],
  go: ['go'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
  csharp: ['cs'],
  java: ['java'],
  image: ['svg', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'ico', 'bmp'],
  archive: ['zip', 'tar', 'gz', '7z', 'tgz', 'xz'],
}).flatMap(([kind, suffixes]) => suffixes.map(suffix => [suffix, kind])));

export function fileIconKind(fileName) {
  const name = fileName.toLowerCase();
  if (/\.d\.[cm]?ts$/.test(name)) return 'declaration';
  if (name.startsWith('.env.')) return 'config';
  const dot = name.lastIndexOf('.');
  return namedIcons.get(name) ?? (dot >= 0 ? suffixIcons.get(name.slice(dot + 1)) : undefined) ?? 'file';
}

const svgNamespace = 'http://www.w3.org/2000/svg';

export function createFileIcon(fileName) {
  const kind = fileIconKind(fileName);
  const [tone, outline, detail] = artwork[kind];
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'file-type-icon');
  svg.dataset.kind = kind;
  svg.dataset.tone = tone;
  const shape = document.createElementNS(svgNamespace, 'path');
  shape.setAttribute('d', outline);
  const accent = document.createElementNS(svgNamespace, 'path');
  accent.setAttribute('d', detail);
  svg.append(shape, accent);
  return svg;
}
