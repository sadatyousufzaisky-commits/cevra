const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const nodeVersion = '24.15.0';
const nodeHash = '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5';
const licenseHash = '4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18';
const licenseUrl = 'https://raw.githubusercontent.com/nodejs/node/v' + nodeVersion + '/LICENSE';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Keep the service file layout so the runner can locate its reporter and process host.
const serviceFiles = [
  'vokri/hosts/cevra/service.cjs', 'vokri/bridge/stdio.cjs',
  'src/atomic-file.cjs', 'src/drafts.cjs', 'src/identity.cjs', 'src/node-reporter.cjs', 'src/preferences.cjs',
  'src/profile-lease.cjs', 'src/profile-location.cjs', 'src/project-tests.cjs',
  'src/runner.cjs', 'src/runtime-kind.cjs', 'src/source-files.cjs', 'src/source-language.cjs',
  'src/source-location.cjs', 'src/source-text.cjs', 'src/workspace.cjs',
  'src/continuum/revisions.cjs', 'src/execution/process-host.cjs', 'src/execution/runtime-location.cjs',
  'src/execution/sessions.cjs', 'src/execution/test-report.cjs',
  'src/intelligence/model-profiles.cjs', 'src/intelligence/provider-contract.cjs', 'src/intelligence/response-preferences.cjs',
];

async function build() {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/build-vokri-product.cjs [new output folder]');
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.electron ||
      process.versions.node !== nodeVersion || sha256(fs.readFileSync(process.execPath)) !== nodeHash) {
    throw new Error('Build with the official Node.js v' + nodeVersion + ' Windows x64 executable.');
  }
  const requested = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'vokri-product'));
  fs.mkdirSync(path.dirname(requested), { recursive: true });
  const parent = fs.realpathSync(path.dirname(requested));
  const destination = path.join(parent, path.basename(requested));
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw new Error('Choose a new output folder: ' + destination);

  const download = await fetch(licenseUrl, { signal: AbortSignal.timeout(20_000) });
  if (!download.ok) throw new Error('Could not download the pinned Node.js license.');
  const license = Buffer.from(await download.arrayBuffer());
  if (sha256(license) !== licenseHash) throw new Error('The Node.js license checksum did not match.');

  for (const script of ['build-process-host.cjs', 'build-vokri.cjs']) {
    execFileSync(process.execPath, [path.join(__dirname, script), ...(script === 'build-vokri.cjs' ? ['--product'] : [])],
      { stdio: 'inherit', windowsHide: true });
  }

  const staging = fs.mkdtempSync(path.join(parent, '.vokri-build-'));
  const entries = new Map();
  function copy(file, source) {
    const target = path.join(staging, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    entries.set(file, sha256(fs.readFileSync(target)));
  }

  try {
    for (const file of serviceFiles) copy(file, path.join(root, file));
    for (const file of ['VokriCode.exe', 'Vokri.dll']) copy(file, path.join(root, 'dist', 'vokri', file));
    copy('dist/vokri-process-host.exe', path.join(root, 'dist', 'vokri-process-host.exe'));
    copy('runtime/node.exe', process.execPath);
    if (entries.get('runtime/node.exe') !== nodeHash) throw new Error('The staged Node.js runtime checksum did not match.');
    fs.writeFileSync(path.join(staging, 'runtime', 'LICENSE'), license, { flag: 'wx' });
    entries.set('runtime/LICENSE', licenseHash);
    fs.writeFileSync(path.join(staging, 'runtime-manifest.json'), JSON.stringify({
      schemaVersion: 1, architecture: 'win-x64', entryPoint: 'VokriCode.exe', nodeVersion,
      files: Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b, 'en'))),
    }, null, 2) + '\n', { flag: 'wx' });
    if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw new Error('The output folder already exists: ' + destination);
    fs.renameSync(staging, destination);
  } finally {
    const leftover = fs.lstatSync(staging, { throwIfNoEntry: false });
    if (leftover?.isDirectory() && !leftover.isSymbolicLink() && fs.realpathSync(staging) === staging &&
        path.dirname(staging) === parent && path.basename(staging).startsWith('.vokri-build-')) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  console.log('Built native product at ' + destination);
}

build().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
