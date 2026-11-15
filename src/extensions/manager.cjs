const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { inspectExtensionPackage } = require('./inspect-package.cjs');
const { comparePermissions, digestPattern, safeText } = require('./capabilities.cjs');
const { comparePackageVersions, packageId } = require('./manifest.cjs');

function createExtensionManager({ registry, broker, owner, choosePackage, catalog, onlineCatalog, confirm }) {
  let review;
  let pending;

  function checkOwner(window) {
    if (!window || owner() !== window) throw new Error('The extension request expired. Reopen Extensions.');
  }

  function run(action) {
    const window = owner();
    checkOwner(window);
    if (pending) throw new Error('Another extension action is in progress.');
    const task = Promise.resolve().then(() => action(window));
    pending = task;
    return task.finally(() => { pending = undefined; });
  }

  async function installed(id, digest) {
    if (!safeText(id, 100) || !packageId.test(id) || typeof digest !== 'string' || !digestPattern.test(digest)) {
      throw new Error('Choose an installed extension.');
    }
    const entry = (await registry.list()).find(extension => extension.id === id);
    if (entry?.sha256 !== digest) throw new Error('The installed extension changed. Refresh and review it again.');
    return entry;
  }

  async function prepareReview(window, { file, archive, report, source, publisher, expiresAt }) {
    const current = (await registry.list()).find(entry => entry.id === report.manifest.id);
    checkOwner(window);
    const token = randomUUID();
    const comparison = current && comparePackageVersions(report.manifest.version, current.version);
    const direction = comparison < 0 ? 'downgrade' : comparison > 0 ? 'upgrade' : 'replacement';
    const update = current ? { direction,
      permissions: current.permissions ? comparePermissions(current.permissions, report.manifest.permissions) : null,
    } : null;
    review = { window, packageSource: archive ?? file, token, id: report.manifest.id, digest: report.sha256, expiresAt,
      expectedCurrent: current?.sha256 ?? null, downgrade: direction === 'downgrade' };
    return { token, report, current: current ?? null, update, source, publisher };
  }

  return {
    get busy() { return Boolean(pending); },
    wait: () => pending?.catch(() => {}),
    discard(token) { if (review?.token === token) review = undefined; },
    clearReview() { review = undefined; },
    select: () => run(async window => {
      review = undefined;
      const file = await choosePackage(window);
      checkOwner(window);
      if (!file) return null;
      const report = await inspectExtensionPackage(file);
      const basename = path.basename(file);
      const source = safeText(basename, 255) ? basename : 'Local ZIP package';
      return prepareReview(window, { file, report, source });
    }),
    selectCatalog: (id, digest, source = 'bundled') => run(async window => {
      review = undefined;
      if (source !== 'bundled' && source !== 'online') throw new Error('Choose an extension catalog.');
      return prepareReview(window, await (source === 'online' ? onlineCatalog : catalog).select(id, digest));
    }),
    inspect: (id, digest) => run(async window => {
      const report = await registry.inspect(id, digest);
      checkOwner(window);
      return report;
    }),
    install: (token, approveDowngrade) => run(async window => {
      if (!review || review.window !== window || review.token !== token) throw new Error('Choose a package and review it again.');
      const { packageSource, id, digest, expectedCurrent, downgrade, expiresAt } = review;
      if (downgrade && approveDowngrade !== true) throw new Error('Approve the older version in the package review.');
      review = undefined;
      if (expiresAt !== undefined && expiresAt <= Date.now()) throw new Error('The online package review expired. Refresh the catalog and review it again.');
      checkOwner(window);
      // The registry publishes a committed replacement before the old host is stopped.
      const result = await registry.install(packageSource, { reviewedDigest: digest, expectedCurrent, allowDowngrade: downgrade });
      if (expectedCurrent && expectedCurrent !== digest) await broker.revoke(id);
      return result;
    }),
    change: (id, digest, action) => run(async window => {
      if (!['enable', 'disable', 'pin', 'unpin', 'quarantine', 'clear-quarantine', 'restore', 'uninstall'].includes(action)) {
        throw new Error('Choose an extension action.');
      }
      const entry = await installed(id, digest);
      checkOwner(window);
      if (action === 'restore' && !entry.rollback) throw new Error('There is no previous extension version to restore.');
      if (action === 'enable') return registry.setEnabled(id, digest, true);
      if (action === 'pin' || action === 'unpin') return registry.setPinned(id, digest, action === 'pin');
      if (action !== 'disable' && !await confirm(window, entry, action)) return null;
      checkOwner(window);
      if (action === 'restore') {
        const result = await registry.rollback(id, digest, entry.rollback.sha256);
        await broker.revoke(id);
        return result;
      }
      await broker.revoke(id);
      checkOwner(window);
      switch (action) {
        case 'disable': return registry.setEnabled(id, digest, false);
        case 'quarantine': return registry.quarantine(id, digest);
        case 'clear-quarantine': {
          const result = await registry.clearQuarantine(id, digest);
          broker.clearFailure(id, digest);
          return result;
        }
        case 'uninstall': return registry.remove(id, digest);
      }
    }),
  };
}

module.exports = { createExtensionManager };
