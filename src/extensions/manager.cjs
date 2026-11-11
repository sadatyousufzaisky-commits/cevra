const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { inspectExtensionPackage } = require('./inspect-package.cjs');
const { digestPattern, safeText } = require('./capabilities.cjs');
const { packageId } = require('./manifest.cjs');

function createExtensionManager({ registry, broker, owner, choosePackage, confirm }) {
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
      const current = (await registry.list()).find(entry => entry.id === report.manifest.id);
      checkOwner(window);
      const token = randomUUID();
      review = { window, file, token, id: report.manifest.id, digest: report.sha256, expectedCurrent: current?.sha256 ?? null };
      const basename = path.basename(file);
      return { token, report, current: current ?? null, source: safeText(basename, 255) ? basename : 'Local ZIP package' };
    }),
    inspect: (id, digest) => run(async window => {
      const report = await registry.inspect(id, digest);
      checkOwner(window);
      return report;
    }),
    install: token => run(async window => {
      if (!review || review.window !== window || review.token !== token) throw new Error('Choose a ZIP package and review it again.');
      const { file, id, digest, expectedCurrent } = review;
      review = undefined;
      if (expectedCurrent && expectedCurrent !== digest) {
        await installed(id, expectedCurrent);
        if ((await inspectExtensionPackage(file)).sha256 !== digest) throw new Error('The package bytes changed after review. Choose the ZIP again.');
        checkOwner(window);
        await broker.revoke(id);
      }
      checkOwner(window);
      return registry.install(file, { reviewedDigest: digest, expectedCurrent });
    }),
    change: (id, digest, action) => run(async window => {
      if (!['enable', 'disable', 'quarantine', 'clear-quarantine', 'restore', 'uninstall'].includes(action)) {
        throw new Error('Choose an extension action.');
      }
      const entry = await installed(id, digest);
      checkOwner(window);
      if (action === 'restore' && !entry.rollback) throw new Error('There is no previous extension version to restore.');
      if (action === 'enable') return registry.setEnabled(id, digest, true);
      if (action !== 'disable' && !await confirm(window, entry, action)) return null;
      checkOwner(window);
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
        case 'restore': return registry.rollback(id, digest, entry.rollback?.sha256);
        case 'uninstall': return registry.remove(id, digest);
      }
    }),
  };
}

module.exports = { createExtensionManager };
