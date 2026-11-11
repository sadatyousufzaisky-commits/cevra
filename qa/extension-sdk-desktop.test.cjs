const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { installSample } = require('./extension-sdk-workbench.cjs');

test('the author starter tools ZIP installs and its snippet and palette survive a disable cycle',
  { timeout: 45_000 }, async t => {
    const { page, editor, open, report, button, state, show } = await installSample(t, {
      source: path.resolve(__dirname, '../examples/extensions/starter-tools'),
      title: 'Starter Tools',
      files: { 'example.js': 'cevrahell' },
    });
    const theme = page.getByRole('combobox', { name: 'Theme' });
    const palette = page.locator('#theme-choice optgroup option').filter({ hasText: 'Tideline' });
    const snippet = page.getByRole('option', { name: /cevrahello.*org\.cevra\.examples\.starter-tools\/hello-log/ });
    const key = report.manifest.id + ':' + report.sha256 + ':tideline';
    const themed = () => page.waitForFunction(value => document.getElementById('theme-choice').value === value &&
      getComputedStyle(document.querySelector('.cm-editor')).backgroundColor === 'rgb(20, 36, 43)', key);

    await button('Enable').click();
    await state('Enabled');
    await button('Close').click();
    await open('example.js');
    await palette.waitFor({ state: 'attached' });
    await theme.selectOption(key);
    await themed();
    await editor.press('Control+End');
    await editor.press('Control+Space');
    await snippet.click();
    await page.locator('#draft-status[data-state="saved"]').waitFor();
    assert.deepEqual(await editor.locator('.cm-line').allTextContents(), ['console.log("Hello from CEVRA!");']);
    await editor.press('Control+z');

    await show();
    await button('Disable').click();
    await state('Disabled');
    await button('Close').click();
    await palette.waitFor({ state: 'detached' });
    assert.notEqual(await theme.inputValue(), key);
    assert.deepEqual(await page.evaluate(() => window.cevra.extensionContributions()), { packages: [], palette: null });

    await show();
    await button('Enable').click();
    await state('Enabled');
    await button('Close').click();
    await themed();
    await editor.press('Control+Space');
    await snippet.waitFor();
  });
