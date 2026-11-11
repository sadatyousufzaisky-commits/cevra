const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { installSample } = require('./extension-sdk-workbench.cjs');

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
