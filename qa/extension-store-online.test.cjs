const assert = require('node:assert/strict');
const { test } = require('node:test');
const { openWorkbench } = require('./desktop-workbench.cjs');

test('the public VOKRI catalog downloads and installs packages inside Electron', { timeout: 60_000 }, async t => {
  const { app, page } = await openWorkbench(t, { 'example.js': 'const ready = true;\n' });
  await app.evaluate(() => {
    const fetch = globalThis.fetch;
    globalThis.storeDownloads = [];
    globalThis.fetch = (url, options) => {
      globalThis.storeDownloads.push(String(url));
      return fetch(url, options);
    };
  });
  const ui = page.getByRole('dialog', { name: 'Extension Manager', exact: true });
  const button = name => ui.getByRole('button', { name, exact: true });
  const store = ui.getByRole('region', { name: 'Extension Store' });
  await page.getByRole('button', { name: 'Extensions', exact: true }).press('Enter');
  await button('Browse Catalog').press('Enter');
  await store.getByRole('heading', { name: 'Online catalog' }).waitFor();
  const published = await page.evaluate(() => window.cevra.extensionStore('online'));
  assert.equal(published.error, undefined);
  for (const release of published.entries) {
    const item = store.getByRole('listitem', { name: release.displayName, exact: true });
    await item.getByRole('button', { name: 'Download & Review', exact: true }).press('Enter');
    const review = ui.getByRole('region', { name: 'Review ' + release.displayName, exact: true });
    await review.getByText('Signed online catalog', { exact: true }).waitFor();
    await review.getByText('Matched the signed catalog digest', { exact: true }).waitFor();
    await review.getByText(release.sha256, { exact: true }).waitFor();
    const installedBefore = await page.evaluate(async () => (await window.cevra.extensionRuntime()).catalog);
    assert.equal(installedBefore.some(entry => entry.id === release.id), false);
    await button('Install Package').press('Enter');
    await ui.getByRole('listitem', { name: release.displayName, exact: true }).getByText('Disabled', { exact: true }).waitFor();
    const installed = await page.evaluate(async () => (await window.cevra.extensionRuntime()).catalog);
    assert.equal(installed.find(entry => entry.id === release.id).sha256, release.sha256);
    await button('Browse Catalog').press('Enter');
  }
  const downloads = await app.evaluate(() => globalThis.storeDownloads);
  assert.ok(downloads.some(url => url.endsWith('/v1/catalog.json')));
  for (const release of published.entries) {
    assert.ok(downloads.some(url => url.endsWith('/v1/packages/' + release.sha256 + '.zip')));
  }
  t.diagnostic('ONLINE_CATALOG ' + JSON.stringify(published.entries.map(({ id, version, sha256 }) => ({ id, version, sha256 }))));
});
