const fs = require('node:fs/promises');
const path = require('node:path');
const { executable } = require('../src/windows-file-types.json');
const manifest = require('../package.json');
const lock = require('../package-lock.json');

const repository = path.resolve(__dirname, '..');
const staging = path.join(repository, 'dist', 'windows-integration');
const runtime = ['workbench.js', 'workbench.css', 'vokri-process-host.exe', 'vokri-credential-vault.exe'];
const extensionHost = ['extension-launcher.exe', 'extension-worker.exe', 'WASMTIME-LICENSE', 'wasmtime.dll'];

async function stage() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the Windows integration preview on Windows x64.');
  const tag = process.argv[2] ?? 'preview';
  if (!/^[a-z0-9][a-z0-9-]{0,35}$/i.test(tag)) throw new Error('Use an alphanumeric preview name, with optional hyphens.');
  await fs.mkdir(staging, { recursive: true });
  const parent = await fs.realpath(staging);
  if (path.relative(staging, parent) !== '') throw new Error('Use the repository staging folder directly.');
  const output = path.join(parent, tag);
  if (await fs.stat(output).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
    throw new Error('A preview with this name already exists. Choose another preview name.');
  }
  const temporary = await fs.mkdtemp(path.join(parent, '.stage-'));
  const app = path.join(temporary, 'resources', 'app');
  try {
    const electron = path.dirname(require('electron'));
    const copy = (relative, destination = path.join(app, relative)) => fs.cp(path.join(repository, relative), destination, { recursive: true });
    for (const entry of await fs.readdir(electron)) {
      if (entry.toLowerCase() === 'resources') continue;
      await fs.cp(path.join(electron, entry), path.join(temporary, entry === 'electron.exe' ? executable : entry), { recursive: true });
    }
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({
      name: manifest.name, productName: manifest.productName, version: manifest.version, main: manifest.main,
    }, null, 2) + '\n');
    for (const folder of ['src', 'assets', 'examples']) await copy(folder);
    for (const file of runtime) await copy('dist/' + file);
    for (const file of extensionHost) await copy('dist/extension-host-lab/' + file);
    for (const [name, dependency] of Object.entries(lock.packages)) {
      if (name.startsWith('node_modules/') && !dependency.dev) await copy(name);
    }
    await copy('scripts/windows-integration.ps1', path.join(temporary, 'windows-integration.ps1'));
    await fs.rename(temporary, output);
    console.log(output);
  } catch (error) {
    if (path.dirname(await fs.realpath(temporary)) === parent) await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

stage().catch(error => { console.error(error.message); process.exitCode = 1; });
