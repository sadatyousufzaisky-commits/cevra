const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { installSample } = require('./extension-sdk-workbench.cjs');
const { openWorkbench } = require('./desktop-workbench.cjs');
const { releases } = require('../assets/extension-store/catalog.json');

test('the compiled author command ZIP runs in the confined host after each explicit grant',
  { timeout: 50_000 }, async t => {
    const { app, report, state, button } = await installSample(t, {
      source: path.resolve(__dirname, '../dist/extension-examples/hello-command'),
      title: 'Hello Command',
      files: { 'example.js': 'const ready = true;\n' },
    });
    const command = button('Run Say hello');
    for (let activation = 0; activation < 2; activation++) {
      await button('Enable').click();
      await state('Enabled');
      await command.waitFor({ state: 'detached' });
      await button('Review Permissions').click();
      await state('Active for this session');
      await command.click();
      await state('Command completed.');
      await button('Disable').click();
      await state('Disabled');
      await command.waitFor({ state: 'detached' });
    }
    const reviews = await app.evaluate(() => globalThis.authorSampleReviews);
    assert.deepEqual(reviews.map(review => review.title), ['Workspace trust', 'Extension permissions', 'Extension permissions']);
    for (const review of reviews.slice(1)) {
      assert.ok(review.detail.includes(report.sha256));
      assert.ok(review.detail.includes('Add commands to Extensions'));
    }
  });

test('G7 a bundled executable receives a confined host only after separate session approval',
  { timeout: 45_000 }, async t => {
    const release = releases.find(item => item.executable);
    const { app, page } = await openWorkbench(t, { 'example.js': 'const ready = true;\n' });
    await app.evaluate(({ dialog }) => {
      globalThis.catalogPrompts = [];
      dialog.showMessageBox = async (_owner, options) => {
        globalThis.catalogPrompts.push({ title: options.title, detail: options.detail, buttons: options.buttons,
          defaultId: options.defaultId });
        const consentAttempts = globalThis.catalogPrompts.filter(prompt => prompt.title === 'Extension permissions').length;
        return { response: options.title === 'Extension permissions' && consentAttempts === 1 ? 0 : 1 };
      };
    });
    const ui = page.getByRole('dialog', { name: 'Extension Manager', exact: true });
    const button = name => ui.getByRole('button', { name, exact: true });
    const entry = ui.getByRole('listitem', { name: release.displayName, exact: true });
    await page.getByRole('button', { name: 'Extensions', exact: true }).press('Enter');
    await button('Browse Catalog').press('Enter');
    await ui.getByRole('combobox', { name: 'Source', exact: true }).selectOption('bundled');
    await entry.getByRole('button', { name: 'Review Package', exact: true }).press('Enter');
    await ui.getByText(release.sha256, { exact: true }).waitFor();
    const review = ui.getByRole('region', { name: 'Review ' + release.displayName, exact: true });
    assert.match(await review.ariaSnapshot(), /Add commands to Extensions/);
    assert.equal((await app.evaluate(() => globalThis.catalogPrompts)).length, 0);
    await button('Install Package').press('Enter');
    await entry.getByText('Disabled', { exact: true }).waitFor();
    await button('Enable').press('Enter');
    await entry.getByText('Enabled', { exact: true }).waitFor();
    assert.equal(await button('Run Say hello').count(), 0);
    await button('Review Permissions').press('Enter');
    await ui.getByText('Activation canceled.', { exact: true }).waitFor();
    assert.equal(await button('Run Say hello').count(), 0);
    await button('Review Permissions').press('Enter');
    await entry.getByText('Active for this session', { exact: true }).waitFor();
    await button('Run Say hello').press('Enter');
    await ui.getByText('Command completed.', { exact: true }).waitFor();
    await button('Revoke Access').press('Enter');
    await button('Run Say hello').waitFor({ state: 'detached' });
    const prompts = await app.evaluate(() => globalThis.catalogPrompts);
    assert.deepEqual(prompts.map(prompt => prompt.title), ['Workspace trust', 'Extension permissions', 'Extension permissions']);
    for (const prompt of prompts.slice(1)) {
      assert.ok(prompt.detail.includes(release.sha256));
      assert.ok(prompt.detail.includes('Add commands to Extensions'));
      assert.deepEqual(prompt.buttons, ['Cancel', 'Allow for This Session']);
      assert.equal(prompt.defaultId, 0);
    }
  });
