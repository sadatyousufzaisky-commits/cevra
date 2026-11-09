function normalizeSource(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function sourceLocation(text, offset) {
  let line = 1;
  let start = 0;
  for (let end = text.indexOf('\n'); end !== -1 && end < offset; end = text.indexOf('\n', start)) {
    line++;
    start = end + 1;
  }
  return { line, column: offset - start + 1 };
}

module.exports = { normalizeSource, sourceLocation };
