const { InspectionError } = require('./inspection-error.cjs');

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const versionPattern = /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/;
const packageId = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const contributionId = /^[a-z][a-z0-9-]*$/;
const unsafeLabel = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u;
const unsafeSnippet = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u;
const languages = new Set(['javascript', 'typescript', 'python', 'json', 'markdown', 'plaintext']);
const palette = ['background', 'foreground', 'accent'];

function reject(where, message) {
  throw new InspectionError('INVALID_MANIFEST', where + ' ' + message);
}

function checkKeys(source) {
  const containers = [];
  const colon = /[\t\r\n ]*:/y;
  // JSON.parse establishes the grammar. A string followed by a colon is an object key.
  for (const match of source.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]]/g)) {
    const token = match[0];
    if (token === '{' || token === '[') {
      if (containers.length === 8) reject('Manifest', 'exceeds the nesting limit.');
      containers.push(token === '{' ? new Set() : null);
    } else if (token === '}' || token === ']') {
      containers.pop();
    } else if (containers.at(-1)) {
      colon.lastIndex = match.index + token.length;
      if (!colon.test(source)) continue;
      const keys = containers.at(-1);
      const key = JSON.parse(token);
      if (keys.has(key)) reject('Manifest', 'contains a duplicate object key.');
      keys.add(key);
    }
  }
}

function decode(bytes) {
  let source;
  try { source = decoder.decode(bytes); }
  catch { reject('Manifest', 'must be valid UTF-8.'); }
  if (source.startsWith('\uFEFF')) reject('Manifest', 'must use UTF-8 without a BOM.');
  let data;
  try { data = JSON.parse(source); }
  catch { reject('Manifest', 'must be valid JSON.'); }
  checkKeys(source);
  return data;
}

function object(value, where, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(where, 'must be an object.');
  for (const key of required) {
    if (!Object.hasOwn(value, key)) reject(where, 'is missing ' + key + '.');
  }
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    reject(where, 'contains an unsupported field.');
  }
}

function text(value, where, min, max, unsafe = unsafeLabel) {
  if (typeof value !== 'string' || value.length < min || value.length > max || !value.trim() ||
      !value.isWellFormed() || unsafe.test(value)) {
    reject(where, 'must be safe text of ' + min + ' to ' + max + ' UTF-16 code units.');
  }
}

function version(value, where) {
  if (typeof value !== 'string' || !versionPattern.test(value)) {
    reject(where, 'must use MAJOR.MINOR.PATCH with up to nine digits per component.');
  }
  return value.split('.').map(Number);
}

function compareVersions(left, right) {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function checkEngine(engines, currentVersion) {
  object(engines, 'Engines', ['cevra']);
  const range = typeof engines.cevra === 'string' && engines.cevra.length <= 62 &&
    /^>=([^ ]+) <([^ ]+)$/.exec(engines.cevra);
  if (!range) reject('Engine range', 'must use ">=MAJOR.MINOR.PATCH <MAJOR.MINOR.PATCH".');
  const min = version(range[1], 'Minimum engine version');
  const max = version(range[2], 'Maximum engine version');
  if (compareVersions(min, max) >= 0) reject('Engine range', 'must have a lower minimum than maximum.');
  const current = version(currentVersion, 'CEVRA version');
  if (compareVersions(current, min) < 0 || compareVersions(current, max) >= 0) {
    throw new InspectionError('INCOMPATIBLE_ENGINE', 'Package requires CEVRA ' + engines.cevra + '. This build is ' + currentVersion + '.');
  }
}

function snippets(value, where) {
  object(value, where, ['id', 'language', 'prefix', 'body'], ['description']);
  if (!languages.has(value.language)) reject(where, 'uses an unsupported language.');
  text(value.prefix, where + ' prefix', 1, 32);
  text(value.body, where + ' body', 1, 2048, unsafeSnippet);
  if (Object.hasOwn(value, 'description')) text(value.description, where + ' description', 1, 320);
}

function themes(value, where) {
  object(value, where, ['id', 'label', 'colors']);
  text(value.label, where + ' label', 1, 80);
  object(value.colors, where + ' palette', palette);
  for (const color of palette) {
    if (typeof value.colors[color] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value.colors[color])) {
      reject(where + ' ' + color, 'must be a literal #RRGGBB color.');
    }
  }
}

function checkContributions(data) {
  object(data, 'Contributions', [], ['snippets', 'themes']);
  if (!Object.keys(data).length) reject('Manifest', 'must contain a snippet or theme.');
  for (const [key, max, validate] of [['snippets', 32, snippets], ['themes', 8, themes]]) {
    if (!Object.hasOwn(data, key)) continue;
    const entries = data[key];
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > max) {
      reject(key, 'must contain between 1 and ' + max + ' entries.');
    }
    const ids = new Set();
    for (const [index, entry] of entries.entries()) {
      const where = key + '[' + index + ']';
      validate(entry, where);
      text(entry.id, where + ' ID', 2, 60);
      if (!contributionId.test(entry.id)) reject(where, 'needs a lowercase contribution ID.');
      if (ids.has(entry.id)) reject(key, 'contains a duplicate contribution ID.');
      ids.add(entry.id);
    }
  }
}

function parseManifest(bytes, currentVersion) {
  const data = decode(bytes);
  object(data, 'Manifest', ['schemaVersion', 'id', 'version', 'displayName', 'description', 'engines', 'permissions', 'contributes']);
  if (data.schemaVersion !== 1) reject('Manifest', 'must use schema version 1.');
  text(data.id, 'Extension ID', 3, 100);
  if (!packageId.test(data.id)) reject('Extension ID', 'must use a lowercase reverse-domain name.');
  version(data.version, 'Extension version');
  text(data.displayName, 'Display name', 1, 80);
  text(data.description, 'Description', 1, 320);
  if (!Array.isArray(data.permissions) || data.permissions.length) reject('Permissions', 'must be an empty array in v1.');
  checkContributions(data.contributes);
  checkEngine(data.engines, currentVersion);
  return data;
}

module.exports = { packageId, parseManifest, versionPattern };
