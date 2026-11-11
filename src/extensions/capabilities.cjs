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

function comparePermissions(installed, requested) {
  const previous = new Map(installed.map(permission => [permission.capability, permission]));
  const next = new Map(requested.map(permission => [permission.capability, permission]));
  const changes = [];
  for (const capability of labels.keys()) {
    const before = previous.get(capability);
    const after = next.get(capability);
    if (!before && !after) continue;
    const beforeFiles = before?.files ?? [];
    const afterFiles = after?.files ?? [];
    const addedFiles = afterFiles.filter(file => !beforeFiles.includes(file)).sort();
    const removedFiles = beforeFiles.filter(file => !afterFiles.includes(file)).sort();
    const drafts = Boolean(before?.drafts) === Boolean(after?.drafts) ? null : after?.drafts ? 'added' : 'removed';
    if (!before || !after || addedFiles.length || removedFiles.length || drafts) {
      changes.push({ capability, status: !before ? 'added' : !after ? 'removed' : 'changed', addedFiles, removedFiles, drafts });
    }
  }
  return changes;
}

module.exports = { canonicalFile, comparePermissions, digestPattern, exactKeys, identifierPattern, permissionLabel, safeText, validPermissions };
