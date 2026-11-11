const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { artifacts } = require('../src/extensions/host-lab/supervisor.cjs');
const { sha256 } = require('../src/extensions/inspect-package.cjs');
const { createExtensionRegistry } = require('../src/extensions/registry.cjs');
const { archive, executableArchive, executableManifest } = require('./extension-fixtures.cjs');

const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const relative = 'nested/value.js';
const original = 'const answer = 1;\n';

async function starterTools() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'examples/extensions/starter-tools/extension.json'), 'utf8'));
  return { manifest, bytes: archive(manifest) };
}

async function commandPackages(count) {
  const module = await fs.readFile(path.join(root, 'dist/extension-examples/hello-command/extension.wasm'));
  return Array.from({ length: count }, (_, index) => {
    const manifest = executableManifest([{ capability: 'commands.register' }], {
      id: 'org.cevra.qa.command-' + (index + 1), displayName: 'QA Command ' + (index + 1), version: '1.0.0',
    });
    return { manifest, module, bytes: executableArchive(manifest, module) };
  });
}

async function brokerPackage() {
  const module = await fs.readFile(path.join(artifacts, 'broker-fixture.wasm'));
  const manifest = executableManifest([
    { capability: 'commands.register' }, { capability: 'workspace.read', files: [relative] },
    { capability: 'diagnostics.publish', files: [relative] }, { capability: 'editor.proposeEdit', files: [relative] },
  ], { id: 'org.cevra.qa.scoped-broker', displayName: 'QA Scoped Broker', version: '1.0.0' });
  return { manifest, module, bytes: executableArchive(manifest, module) };
}

async function writePackage(folder, { manifest, bytes }) {
  const filename = path.join(folder, manifest.id + '-' + manifest.version + '.zip');
  await fs.writeFile(filename, bytes, { flag: 'wx' });
  return { filename, digest: sha256(bytes) };
}

async function seedExtensions(profile, packages) {
  const registry = createExtensionRegistry(profile);
  for (const fixture of packages) {
    const { filename, digest } = await writePackage(profile, fixture);
    await registry.install(filename, { reviewedDigest: digest });
    await registry.setEnabled(fixture.manifest.id, digest, true);
    await fs.unlink(filename);
  }
}

function manager(page) {
  const dialog = page.getByRole('dialog', { name: 'Extension Manager', exact: true });
  const button = (name, container = dialog) => container.getByRole('button', { name, exact: true });
  return {
    dialog, button,
    row: ({ manifest }) => dialog.getByRole('listitem', { name: manifest.displayName, exact: true }),
    open: () => button('Extensions', page).click(),
    status: dialog.locator('#extension-manager-status'),
  };
}

async function desktopHosts(app) {
  const owner = await app.evaluate(() => process.pid);
  assert.ok(Number.isInteger(owner) && owner > 0);
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const query = `$ErrorActionPreference = 'Stop'
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'extension-launcher.exe' OR Name = 'extension-worker.exe'")
    $launchers = @($processes | Where-Object { $_.Name -eq 'extension-launcher.exe' -and $_.ParentProcessId -eq ${owner} })
    $workers = @($processes | Where-Object { $_.Name -eq 'extension-worker.exe' -and $_.ParentProcessId -in $launchers.ProcessId })
    ConvertTo-Json -Compress -InputObject @(@($launchers) + @($workers) | Select-Object Name,ProcessId,WorkingSetSize)`;
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', query], { windowsHide: true, timeout: 12_000 });
  return JSON.parse(stdout).map(item => ({
    pid: item.ProcessId, workingSet: Number(item.WorkingSetSize), worker: item.Name === 'extension-worker.exe',
  }));
}

module.exports = { brokerPackage, commandPackages, desktopHosts, manager, original, relative, seedExtensions, starterTools, writePackage };
