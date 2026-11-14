const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { openWorkbench } = require('./desktop-workbench.cjs');

const evidence = process.env.VOKRI_DESIGN_SCREENSHOTS;

async function screenshot(page, name, scaled) {
  if (!evidence) return;
  await fs.mkdir(evidence, { recursive: true });
  if (scaled) {
    const { data } = await scaled.client.send('Page.captureScreenshot', { format: 'png' });
    const png = Buffer.from(data, 'base64');
    assert.equal(png.readUInt32BE(16), scaled.width);
    await fs.writeFile(path.join(evidence, name + '.png'), png);
    return;
  }
  await page.screenshot({ path: path.join(evidence, name + '.png'), fullPage: true, animations: 'disabled' });
}

function luminance(hex) {
  assert.match(hex, /^#[\da-f]{3}(?:[\da-f]{3})?$/i);
  const digits = hex.slice(1);
  const channels = (digits.length === 3 ? [...digits].map(digit => digit.repeat(2)) : digits.match(/../g))
    .map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

async function auditContrast(page, mode) {
  const pairs = [
    ['text', 'base', 4.5], ['text', 'panel', 4.5], ['text', 'raised', 4.5],
    ['muted', 'chrome', 4.5], ['muted', 'dock', 4.5], ['current-text', 'selected', 4.5],
    ['ink', 'accent', 4.5], ['ink', 'primary-hover', 4.5], ['ink', 'primary-pressed', 4.5],
    ['text', 'button-fill', 4.5], ['text', 'button-hover', 4.5], ['text', 'button-pressed', 4.5],
    ['danger', 'error-surface', 4.5], ['warning', 'dock', 4.5], ['verified', 'panel', 4.5],
    ['focus-ring', 'base', 3], ['focus-ring', 'chrome', 3],
    ['focus-ring', 'selected', 3], ['accent', 'chrome', 3], ['control-border', 'base', 3],
    ['control-border', 'chrome', 3], ['control-border', 'panel', 3],
    ...['amber', 'blue', 'cyan', 'coral', 'iris'].flatMap(tone =>
      ['chrome', 'panel', 'selected'].map(surface => ['icon-' + tone, surface, 3])),
  ];
  const names = [...new Set(pairs.flatMap(pair => pair.slice(0, 2)))];
  const values = await page.evaluate(tokens => {
    const styles = getComputedStyle(document.documentElement);
    return Object.fromEntries(tokens.map(name => [name, styles.getPropertyValue('--' + name).trim()]));
  }, names);
  const minimums = { text: Infinity, nonText: Infinity };
  for (const [foreground, background, required] of pairs) {
    const valuesByBrightness = [luminance(values[foreground]), luminance(values[background])].sort((a, b) => b - a);
    const ratio = (valuesByBrightness[0] + 0.05) / (valuesByBrightness[1] + 0.05);
    assert.ok(ratio >= required, `${mode} --${foreground}/--${background} is ${ratio.toFixed(2)}:1, requires ${required}:1`);
    const group = required === 4.5 ? 'text' : 'nonText';
    minimums[group] = Math.min(minimums[group], ratio);
  }
  return minimums;
}

test('G1 workbench shares semantic states and file artwork across list and tabs', { timeout: 60_000 }, async t => {
  const wb = await openWorkbench(t, {
    'app.js': 'throw new Error("G1 observed failure");\n',
    'types.d.MTS': 'export declare const value: number;\n',
    'package.json': '{}\n',
    'notes [é] & why.MD': '# Notes\n',
    'LICENSE': 'Sample license text\n',
    'nested/SURVEY.PY': 'print("survey")\n',
    'nested/matching.js': 'console.log("run");\n',
  });
  const { page } = wb;
  await wb.file('nested').press('Enter');
  await wb.file('SURVEY.PY').waitFor();
  for (const [name, kind] of Object.entries({
    'app.js': 'javascript', 'types.d.MTS': 'declaration', 'package.json': 'package',
    'notes [é] & why.MD': 'markdown', LICENSE: 'file', 'SURVEY.PY': 'python',
  })) {
    const row = wb.file(name);
    await wb.open(name);
    const rowIcon = row.locator('svg.file-type-icon');
    const tabIcon = page.locator('#tabs [aria-current="true"] svg.file-type-icon');
    assert.equal(await rowIcon.getAttribute('data-kind'), kind);
    assert.equal(await tabIcon.getAttribute('data-kind'), kind);
    assert.equal(await tabIcon.getAttribute('aria-hidden'), 'true');
    assert.equal(await tabIcon.evaluate(icon => icon.getBoundingClientRect().width), 16);
    const stroke = node => node.evaluate(icon => getComputedStyle(icon.firstElementChild).stroke);
    assert.equal(await stroke(rowIcon), await stroke(tabIcon));
    assert.equal(await row.getAttribute('aria-current'), 'true');
  }

  const theme = page.getByLabel('Theme', { exact: true });
  await theme.selectOption('dark');
  await page.locator('html[data-color-mode=dark]').waitFor({ state: 'attached' });
  t.diagnostic('Dark minimum contrast ratios ' + JSON.stringify(await auditContrast(page, 'dark')));
  await wb.open('app.js');
  await page.getByRole('button', { name: /Run file/ }).press('Enter');
  await wb.output.getByText('G1 observed failure', { exact: false }).waitFor();
  await page.locator('#run-state[data-state="error"]').waitFor();
  await page.mouse.move(4, 4);
  assert.deepEqual(await page.evaluate(() => {
    const workbench = document.getElementById('workbench').getBoundingClientRect();
    const explorer = document.getElementById('workspace-sidebar').getBoundingClientRect();
    const dock = document.getElementById('run-panel').getBoundingClientRect();
    return { fullWidth: dock.width === workbench.width && dock.left === workbench.left, belowExplorer: dock.top === explorer.bottom };
  }), { fullWidth: true, belowExplorer: true });
  assert.deepEqual(await page.evaluate(() => {
    const styles = getComputedStyle(document.getElementById('run-file'));
    return {
      radius: styles.borderRadius,
      outputRadius: getComputedStyle(document.getElementById('run-panel')).borderRadius,
      buttonFill: getComputedStyle(document.getElementById('open-folder')).backgroundColor,
      chrome: getComputedStyle(document.querySelector('.titlebar')).backgroundColor,
    };
  }), { radius: '5px', outputRadius: '5px', buttonFill: 'rgb(37, 37, 57)', chrome: 'rgb(19, 19, 23)' });
  await screenshot(page, 'g1-workbench-dark');
  await page.locator('#jump-to-error').press('Enter');
  await page.waitForFunction(() => document.activeElement?.matches('.cm-content'));
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Editor Settings' });
  await dialog.waitFor();
  assert.match(await dialog.ariaSnapshot(), /spinbutton "Font size"/);
  await screenshot(page, 'g1-workbench-settings');
  await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await settings.evaluate(node => node === document.activeElement), true);
  await theme.selectOption('light');
  await page.locator('html[data-color-mode=light]').waitFor({ state: 'attached' });
  t.diagnostic('Light minimum contrast ratios ' + JSON.stringify(await auditContrast(page, 'light')));
  await screenshot(page, 'g1-workbench-light');
  const cdp = await page.context().newCDPSession(page);
  for (const scale of [1, 1.25, 1.5, 2]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 720, deviceScaleFactor: scale, mobile: false });
    assert.equal(await page.evaluate(() => devicePixelRatio), scale);
    await settings.press('Enter');
    await dialog.waitFor();
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await screenshot(page, `g1-workbench-settings-${scale * 100}`, { client: cdp, width: 1200 * scale });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  }
});

test('G1 prototypes exercise keyboard flows and draw distinct accessible states across display scales', { timeout: 60_000 }, async t => {
  const { app } = await openWorkbench(t, {});
  const opened = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, document) => {
    const preview = new BrowserWindow({ width: 1080, height: 850, webPreferences: { sandbox: true } });
    await preview.loadFile(document);
  }, path.resolve(__dirname, '../docs/phase-6/design/preview.html'));
  const preview = await opened;
  preview.setDefaultTimeout(5_000);
  const direction = preview.getByLabel('Direction');
  assert.equal(await direction.inputValue(), 'ink');
  assert.equal(await preview.locator('.workspace').evaluate(node => getComputedStyle(node).borderRadius), '5px');
  const appearance = preview.getByLabel('Appearance');
  const source = preview.getByRole('textbox', { name: 'main.ts', exact: true });
  const run = preview.getByRole('button', { name: 'Run sample' });
  const status = preview.getByRole('status');
  const save = preview.getByRole('button', { name: 'Save', exact: true });
  const stop = preview.getByRole('button', { name: 'Stop', exact: true });
  const settings = preview.getByRole('button', { name: 'Settings', exact: true });
  const prefs = preview.getByRole('dialog', { name: 'Editor settings' });
  assert.equal(await preview.locator('#icons li').count(), 25);
  assert.equal(await new Set(await preview.locator('#icons svg').evaluateAll(icons => icons.map(icon => icon.dataset.kind))).size, 25);
  await direction.focus();
  await preview.keyboard.press('Tab');
  assert.equal(await appearance.evaluate(node => document.activeElement === node), true);
  await preview.keyboard.press('Tab');
  assert.equal(await settings.evaluate(node => document.activeElement === node && node.matches(':focus-visible')), true);
  await preview.keyboard.press('Enter');
  await prefs.waitFor();
  assert.match(await prefs.ariaSnapshot(), /spinbutton "Font size"/);
  await preview.keyboard.press('Escape');
  await prefs.waitFor({ state: 'hidden' });
  assert.equal(await settings.evaluate(node => document.activeElement === node), true);
  await source.focus();
  await preview.keyboard.press('End');
  await preview.keyboard.type(' // draft');
  assert.equal(await save.isEnabled(), true);
  await save.press('Enter');
  await status.getByText('Saved main.ts', { exact: true }).waitFor();
  await preview.getByRole('button', { name: 'bad.js', exact: true }).press('Enter');
  await run.press('Enter');
  await status.getByText('Running bad.js', { exact: true }).waitFor();
  assert.equal(await stop.evaluate(node => node === document.activeElement), true);
  await stop.press('Enter');
  await status.getByText('Stopped', { exact: true }).waitFor();
  await run.press('Enter');
  await status.getByText('TypeError in bad.js, line 2', { exact: true }).waitFor();
  await preview.getByRole('button', { name: 'Go to error' }).press('Enter');
  const problem = preview.getByRole('textbox', { name: 'bad.js' });
  assert.equal(await problem.evaluate(node => node === document.activeElement && node.selectionStart > 0), true);

  const cdp = await preview.context().newCDPSession(preview);
  for (const candidate of ['midnight', 'platinum', 'ink']) {
    await direction.selectOption(candidate);
    for (const mode of ['dark', 'light']) {
      await appearance.selectOption(mode);
      assert.equal(await preview.locator('html').getAttribute('data-color-mode'), mode);
      const minimums = await auditContrast(preview, candidate + ' ' + mode);
      t.diagnostic(candidate + ' ' + mode + ' minimum contrast ratios ' + JSON.stringify(minimums));
      await screenshot(preview, `g1-prototype-${candidate}-${mode}`);
    }
  }
  await direction.selectOption('ink');
  for (const scale of [1, 1.25, 1.5, 2]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: scale, mobile: false });
    assert.equal(await preview.evaluate(() => devicePixelRatio), scale);
    for (const mode of ['dark', 'light']) {
      await appearance.selectOption(mode);
      assert.equal(await status.getAttribute('class'), 'feedback-error');
      assert.ok((await run.boundingBox()).height >= 24);
      assert.equal(await preview.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await run.hover();
      const color = () => run.evaluate(node => getComputedStyle(node).backgroundColor);
      const idleHover = await color();
      await preview.mouse.down();
      assert.notEqual(await color(), idleHover);
      await screenshot(preview, `g1-pressed-${mode}-${scale * 100}`, { client: cdp, width: 1000 * scale });
      await preview.mouse.move(4, 4);
      await preview.mouse.up();
      await settings.focus();
      await preview.keyboard.press('Tab');
      assert.equal(await run.evaluate(node => node === document.activeElement && node.matches(':focus-visible')), true);
      await screenshot(preview, `g1-controls-${mode}-${scale * 100}`, { client: cdp, width: 1000 * scale });
      await run.press('Enter');
      await status.getByText('Running bad.js', { exact: true }).waitFor();
      await screenshot(preview, `g1-busy-${mode}-${scale * 100}`, { client: cdp, width: 1000 * scale });
      await status.getByText('TypeError in bad.js, line 2', { exact: true }).waitFor();
    }
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 500, deviceScaleFactor: 2, mobile: false });
  for (const candidate of ['midnight', 'platinum', 'ink']) {
    await direction.selectOption(candidate);
    assert.equal(await preview.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await direction.selectOption('ink');
  await preview.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  const highContrastStrokes = await preview.locator('#icons svg path:first-child').evaluateAll(paths =>
    [...new Set(paths.map(shape => getComputedStyle(shape).stroke))]);
  assert.equal(highContrastStrokes.length, 1);
  await run.press('Enter');
  assert.equal(await status.evaluate(node => getComputedStyle(node, '::before').animationName), 'none');
  assert.equal(await preview.evaluate(() => matchMedia('(forced-colors: active)').matches), true);
  await status.getByText('TypeError in bad.js, line 2', { exact: true }).waitFor();
  await screenshot(preview, 'g1-controls-forced-colors', { client: cdp, width: 760 });
});

test('Midnight Atelier follows the saved theme through restart and Intelligence', { timeout: 35_000 }, async t => {
  let workbench = await openWorkbench(t, { 'app.js': 'const sample = 1;\n' }, undefined, { args: ['--enable-intelligence-mock'] });
  const theme = page => page.getByRole('combobox', { name: 'Theme' });
  const select = async (page, choice, direction) => {
    await theme(page).selectOption(choice);
    await page.locator(`html[data-direction=${direction}]`).waitFor({ state: 'attached' });
    await page.locator('#message').getByText('Theme saved.', { exact: true }).waitFor();
  };
  await workbench.open('app.js');
  await select(workbench.page, 'midnight', 'midnight');
  assert.equal(await workbench.page.locator('#open-folder').evaluate(node => getComputedStyle(node).borderRadius), '5px');
  t.diagnostic('Midnight Atelier minimum contrast ratios ' + JSON.stringify(await auditContrast(workbench.page, 'Midnight Atelier')));
  await screenshot(workbench.page, 'g1-workbench-midnight');
  const appArgs = ['--enable-intelligence-mock'];
  workbench = await workbench.restart({ args: appArgs });
  const { app, page, profile } = workbench;
  await page.locator('html[data-direction=midnight][data-color-mode=dark]').waitFor({ state: 'attached' });
  assert.equal(await theme(page).inputValue(), 'midnight');
  assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'preferences.json'), 'utf8')).theme, 'midnight');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase()), '#11111c');
  const opened = app.waitForEvent('window');
  await page.getByRole('button', { name: 'VOKRI Intelligence', exact: true }).click();
  const intelligence = await opened;
  await intelligence.locator('html[data-direction=midnight]').waitFor({ state: 'attached' });
  assert.equal(await intelligence.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(17, 17, 28)');
  await page.bringToFront();
  await select(page, 'dark', 'ink');
  await intelligence.locator('html[data-direction=ink]').waitFor({ state: 'attached' });
  assert.equal(await intelligence.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(19, 19, 23)');
});
