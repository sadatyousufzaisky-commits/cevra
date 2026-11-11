const labels = new Map([
  ['commands.register', 'Add commands to Extensions'], ['diagnostics.publish', 'Show problems for these files'],
  ['editor.readSelection', 'Read selected text in these open files'], ['workspace.read', 'Read these saved files'],
  ['editor.proposeEdit', 'Propose edits to these files'],
]);
const unsafeText = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u;
const digestPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[a-z][a-z0-9-]{1,59}$/;

function safeText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value.trim().length > 0 && value.isWellFormed() && !unsafeText.test(value);
}

function exactKeys(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function canonicalFile(value) {
  return safeText(value, 240) && !/[\\:<>"|?*]/.test(value) &&
    !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..' &&
      !/[. ]$/.test(part) && !['.git', 'node_modules'].includes(part.toLowerCase()) &&
      !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
}

function validPermissions(permissions) {
  if (!Array.isArray(permissions) || !permissions.length || permissions.length > labels.size || JSON.stringify(permissions).length > 4096) return false;
  const seen = new Set();
  for (const permission of permissions) {
    if (!labels.has(permission?.capability) || seen.has(permission.capability)) return false;
    seen.add(permission.capability);
    if (permission.capability === 'commands.register') {
      if (!exactKeys(permission, ['capability'])) return false;
      continue;
    }
    if (!exactKeys(permission, ['capability', 'files'], permission.capability === 'workspace.read' ? ['drafts'] : [])) return false;
    if (!Array.isArray(permission.files) || !permission.files.length || permission.files.length > 32 ||
        !permission.files.every(canonicalFile) || new Set(permission.files.map(file => file.toLowerCase())).size !== permission.files.length) return false;
    if (Object.hasOwn(permission, 'drafts') && typeof permission.drafts !== 'boolean') return false;
  }
  return true;
}

function permissionLabel(permission) {
  return labels.get(permission.capability) + (permission.drafts ? ' and open drafts' : '');
}

module.exports = { canonicalFile, digestPattern, exactKeys, identifierPattern, permissionLabel, safeText, validPermissions };
