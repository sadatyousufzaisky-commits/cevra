const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { openWorkbench } = require('./desktop-workbench.cjs');

const exec = promisify(execFile);
const packer = path.resolve(__dirname, '../scripts/pack-extension.cjs');

async function installSample(t, { source, title, files }) {
  let filename;
  let report;
  const workbench = await openWorkbench(t, files, async (_project, profile) => {
    filename = path.join(path.dirname(profile), title + ' café (#%).zip');
    const { stdout } = await exec(process.execPath, [packer, source, filename]);
    report = JSON.parse(stdout);
  });
  await workbench.app.evaluate(({ dialog }, { filename, project }) => {
    dialog.showOpenDialog = async (_owner, options) => ({
      canceled: false, filePaths: [options.title === 'Choose an extension package' ? filename : project],
    });
    globalThis.authorSampleReviews = [];
    dialog.showMessageBox = async (_owner, options) => {
      globalThis.authorSampleReviews.push({ title: options.title, detail: options.detail });
      return { response: 1 };
    };
  }, { filename, project: workbench.project });
  const { page } = workbench;
  const dialog = page.getByRole('dialog', { name: 'Extension Manager', exact: true });
  const show = () => page.getByRole('button', { name: 'Extensions', exact: true }).click();
  const button = name => dialog.getByRole('button', { name, exact: true });
  const state = text => dialog.getByText(text, { exact: true }).waitFor();
  await show();
  await button('Choose ZIP Package').click();
  await dialog.getByRole('heading', { name: 'Review ' + title, exact: true }).waitFor();
  await state(report.sha256);
  await button('Install Package').click();
  await state('Disabled');
  return { ...workbench, report, button, state, show };
}

module.exports = { installSample };
