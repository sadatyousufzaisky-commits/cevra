const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const associations = require('../src/windows-file-types.json');
const product = require('../packaging/windows/product.json');
const { versionParts } = require('../src/windows-update.cjs');
const { appId } = require('../src/identity.cjs');
const packageJson = require('../package.json');
const lock = require('../package-lock.json');

const run = promisify(execFile);
const repo = path.resolve(__dirname, '..');
const source = path.join(repo, 'packaging', 'windows');
const dist = path.join(repo, 'dist');
const toolchain = path.join(dist, 'g11-toolchain');
const wix = path.join(toolchain, 'wix', 'tools', 'net6.0', 'any', 'wix.dll');
const ui = path.join(toolchain, 'wixtoolset.ui.wixext', 'wixext6', 'WixToolset.UI.wixext.dll');
const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function msiVersion(version) {
  return versionParts(version) !== null;
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

function id(value) {
  return 'V' + createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function guid(value) {
  const hex = id(value).slice(1).toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

async function payloadFiles(root) {
  const files = [];
  async function visit(relative) {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.push({ name, file: path.join(root, name) });
      else throw new Error('The staged installer payload contains a link or special file.');
    }
  }
  await visit('');
  return files.filter(({ name }) => name !== 'windows-integration.ps1');
}

function registry(key, name, value, root, keyPath = false) {
  return `<RegistryValue Root="${root}" Key="${xml(key)}" ${name ? `Name="${xml(name)}" ` : ''}Type="string" Value="${xml(value)}"${keyPath ? ' KeyPath="yes"' : ''} />`;
}

function explorerRegistry(hive) {
  const base = 'Software\\Classes\\';
  const capability = 'Software\\Vokri\\WindowsIntegration\\Capabilities';
  const application = base + 'Applications\\' + associations.executable;
  const folder = base + 'Directory\\shell\\VokriCode.Open';
  const command = `"[INSTALLFOLDER]${associations.executable}" --vokri-open -- "%1"`;
  const asset = 'resources\\app\\assets\\brand\\';
  const icon = '"' + '[INSTALLFOLDER]' + asset + 'vc.ico",0';
  const entries = [];
  const add = (key, name, value) => entries.push(registry(key, name, value, hive));
  const owner = key => add(key, 'VokriRegistrationOwner', 'Vokri.Code.Installer');
  for (const key of [capability, application, folder]) owner(key);
  add(capability, 'ApplicationName', associations.application);
  add(capability, 'ApplicationDescription', 'Edit source code, data, and text files with VOKRI Code.');
  add(capability, 'ApplicationIcon', icon);
  add('Software\\RegisteredApplications', associations.application, capability);
  add(application, 'FriendlyAppName', associations.application);
  add(application + '\\DefaultIcon', '', icon);
  add(application + '\\shell\\open', 'MultiSelectModel', 'Document');
  add(application + '\\shell\\open\\command', '', command);
  add(folder, 'MUIVerb', 'Open Folder with VOKRI Code');
  add(folder, 'Icon', icon);
  add(folder, 'MultiSelectModel', 'Document');
  add(folder + '\\command', '', command);
  for (const [category, extensions] of Object.entries(associations.types)) {
    const progId = `Vokri.Code.${category}.${associations.version}`;
    const key = base + progId;
    const label = `VOKRI Code ${category.toLowerCase()} document`;
    owner(key);
    add(key, '', label);
    add(key, 'FriendlyTypeName', label);
    add(key + '\\Application', 'ApplicationName', associations.application);
    add(key + '\\Application', 'ApplicationIcon', icon);
    add(key + '\\DefaultIcon', '', `"[INSTALLFOLDER]${asset}documents\\${category.toLowerCase()}.ico",0`);
    add(key + '\\shell\\open', 'MultiSelectModel', 'Document');
    add(key + '\\shell\\open\\command', '', command);
    for (const extension of extensions) {
      add(capability + '\\FileAssociations', extension, progId);
      add(base + extension + '\\OpenWithProgids', progId, '');
      add(application + '\\SupportedTypes', extension, '');
    }
  }
  return entries.join('\n');
}

function fragment(files, { scope, version, rollbackBytes }) {
  const currentUser = scope === 'perUser';
  const hive = currentUser ? 'HKCU' : 'HKLM';
  const parent = currentUser ? 'LocalAppDataFolder' : 'ProgramFiles64Folder';
  const keys = 'Software\\Vokri\\Installer';
  const directoryId = relative => relative === '.' ? 'INSTALLFOLDER' : id('folder:' + relative);
  const components = new Map();
  const references = [];
  const directories = new Set(['.']);
  for (const item of files) {
    const relative = path.dirname(item.name);
    const component = id('component:' + item.name);
    const fileId = item.name === associations.executable ? 'VokriExecutable' : id('file:' + item.name);
    const keyPath = currentUser ? registry(keys + '\\Files', component, '1', hive, true) : '';
    const value = `<Component Id="${component}" Guid="${guid(scope + ':' + item.name)}" Bitness="always64">
      <File Id="${fileId}" Source="${xml(item.file)}" KeyPath="${currentUser ? 'no' : 'yes'}" />${keyPath}
    </Component>`;
    if (!components.has(relative)) components.set(relative, []);
    components.get(relative).push(value);
    references.push(component);
    for (let itemDir = relative; itemDir !== '.'; itemDir = path.dirname(itemDir)) directories.add(itemDir);
  }
  for (const relative of directories) {
    const component = id('remove:' + relative);
    if (!components.has(relative)) components.set(relative, []);
    components.get(relative).push(`<Component Id="${component}" Guid="${guid(scope + ':remove:' + relative)}" Bitness="always64">
      <RemoveFolder Id="${id('remove-folder:' + relative)}" On="uninstall" />
      ${registry(keys + '\\Folders', component, '1', hive, true)}
    </Component>`);
    references.push(component);
  }
  function tree(relative) {
    return [...directories].filter(dir => dir !== '.' && path.dirname(dir) === relative)
      .map(dir => `<Directory Id="${directoryId(dir)}" Name="${xml(path.basename(dir))}">${tree(dir)}</Directory>`).join('\n');
  }
  function shortcut(component, folder) {
    return `<StandardDirectory Id="${folder}"><Component Id="${component}" Guid="${guid(scope + ':' + component)}" Bitness="always64">
      <Shortcut Id="${component}Entry" Name="VOKRI Code" Description="Open VOKRI Code" Target="[INSTALLFOLDER]${associations.executable}" WorkingDirectory="INSTALLFOLDER" Icon="VokriBrand">
        <ShortcutProperty Key="System.AppUserModel.ID" Value="${xml(appId)}" />
      </Shortcut>
      ${registry(keys, component, '1', currentUser ? 'HKCU' : 'HKMU', true)}
    </Component></StandardDirectory>`;
  }
  const rootDirectory = `<Directory Id="INSTALLFOLDER" Name="VOKRI Code">${tree('.')}</Directory>`;
  return `<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Fragment>
    <StandardDirectory Id="${parent}">${currentUser ? `<Directory Id="LocalPrograms" Name="Programs">${rootDirectory}</Directory>` : rootDirectory}</StandardDirectory>
    ${[...components].map(([dir, values]) => `<DirectoryRef Id="${directoryId(dir)}">${values.join('\n')}</DirectoryRef>`).join('\n')}
    <DirectoryRef Id="INSTALLFOLDER">
      <Component Id="InstallationRecord" Guid="${guid(scope + ':record')}" Bitness="always64">
        ${currentUser ? '<RemoveFolder Id="RemoveEmptyLocalPrograms" Directory="LocalPrograms" On="uninstall" />' : ''}
        <ReserveCost Id="RollbackRoom" RunFromSource="0" RunLocal="${rollbackBytes}" />
        ${registry(keys, 'Scope', scope, hive, true)}
        ${registry(keys, 'Version', version, hive)}
        ${registry(keys, 'Location', '[INSTALLFOLDER]', hive)}
      </Component>
      <Component Id="ExplorerRegistration" Guid="${guid(scope + ':explorer')}" Bitness="always64">
        ${registry(keys, 'ExplorerIntegration', '1', hive, true)}
        ${explorerRegistry(hive)}
      </Component>
    </DirectoryRef>
    ${shortcut('StartShortcut', 'ProgramMenuFolder')}
    ${shortcut('DesktopLink', 'DesktopFolder')}
    <ComponentGroup Id="AppFiles">${references.map(value => `<ComponentRef Id="${value}" />`).join('\n')}</ComponentGroup>
  </Fragment>
</Wix>\n`;
}

async function hash(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}

async function invoke(executable, args) {
  try {
    const result = await run(executable, args, { cwd: repo, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (result.stdout.trim()) process.stdout.write(result.stdout);
    if (result.stderr.trim()) process.stderr.write(result.stderr);
  } catch (error) {
    throw new Error([error.stdout, error.stderr].filter(Boolean).join('\n').trim() || error.message);
  }
}

async function validateMsi(msi, scopeName) {
  // The all-users package has shared shortcut folders. The account package has a fixed profile path.
  const scopeRules = ['-sice', scopeName === 'machine' ? 'ICE57' : 'ICE91'];
  await invoke('dotnet', ['--roll-forward', 'Major', wix, 'msi', 'validate', ...scopeRules, msi]);
}

async function buildMsi({ version, scopeName, stage, output, signer = '', fault = false }) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the installer on Windows x64.');
  if (!msiVersion(version)) throw new Error('Use a Windows Installer version such as 0.1.0.');
  const details = product[scopeName];
  if (!details || !['account', 'machine'].includes(scopeName)) throw new Error('Choose the account or machine installation scope.');
  if (signer && !/^[A-F0-9]{40}$/i.test(signer)) throw new Error('Supply the 40-character code-signing certificate thumbprint.');
  for (const file of [wix, ui]) await fs.access(file).catch(() => { throw new Error('Run scripts/get-windows-installer-toolchain.ps1 to prepare WiX.'); });
  await fs.mkdir(path.dirname(output), { recursive: true });
  const work = await fs.mkdtemp(path.join(path.dirname(output), 'wix-'));
  const files = await payloadFiles(stage);
  const installerInfo = path.join(work, 'windows-installation.json');
  const stagedManifest = JSON.parse(await fs.readFile(path.join(stage, 'resources', 'app', 'package.json'), 'utf8'));
  stagedManifest.version = version;
  const appManifest = path.join(work, 'package.json');
  await fs.writeFile(appManifest, JSON.stringify(stagedManifest, null, 2) + '\n');
  const appManifestName = path.join('resources', 'app', 'package.json');
  files.find(item => item.name === appManifestName).file = appManifest;
  await fs.writeFile(installerInfo, JSON.stringify({
    scope: details.scope, upgradeCode: details.upgradeCode, signer: signer.toUpperCase(),
  }, null, 2) + '\n');
  files.push({ name: path.join('resources', 'app', 'windows-installation.json'), file: installerInfo });
  let rollbackBytes = 0;
  for (const file of files) {
    file.bytes = (await fs.stat(file.file)).size;
    rollbackBytes += file.bytes;
  }
  if (rollbackBytes > 0x7fffffff) throw new Error('The payload exceeds the supported Windows Installer disk cost.');
  const generated = path.join(work, 'payload.wxs');
  await fs.writeFile(generated, fragment(files, { scope: details.scope, version, rollbackBytes }));
  const setupInformation = path.join(work, 'setup.rtf');
  const scope = scopeName === 'account' ? 'your Windows account' : 'all users of this computer';
  const location = scopeName === 'account' ? 'Local AppData, under Programs' : 'Program Files';
  await fs.writeFile(setupInformation, `{\\rtf1\\ansi{\\fonttbl{\\f0 Segoe UI;}}\\f0\\fs20
\\b Installation scope\\b0\\par VOKRI Code will be installed for ${scope} in ${location}.\\par\\par
\\b Optional features\\b0\\par Choose a desktop shortcut or add VOKRI Code to File Explorer. Use Windows Settings to choose default apps.\\par\\par
\\b Removing VOKRI Code\\b0\\par Installed apps can repair or remove the editor. Your projects, profiles, and draft backups are stored separately.}`);
  await invoke(ps, ['-NoProfile', '-File', path.join(repo, 'scripts', 'render-windows-setup.ps1'), '-Output', work]);
  const definitions = {
    Version: version, Scope: details.scope, UpgradeCode: details.upgradeCode,
    ProductCode: guid(`${details.upgradeCode}:${version}`), OtherHive: scopeName === 'account' ? 'HKLM' : 'HKCU',
    ThisHive: scopeName === 'account' ? 'HKCU' : 'HKLM', TestFault: fault ? 'yes' : 'no',
    BrandIcon: path.join(repo, 'assets', 'brand', 'vc.ico'), Banner: path.join(work, 'banner.bmp'),
    Dialog: path.join(work, 'dialog.bmp'), SetupInformation: setupInformation,
  };
  const intermediate = await fs.mkdtemp(path.join(work, 'intermediate-'));
  try {
    await invoke('dotnet', ['--roll-forward', 'Major', wix, 'build', path.join(source, 'product.wxs'), generated, '-arch', 'x64',
      '-ext', ui, '-loc', path.join(source, 'setup.wxl'), '-culture', 'en-us', '-o', output,
      '-intermediateFolder', intermediate, ...Object.entries(definitions).flatMap(([key, value]) => ['-d', key + '=' + value])]);
  } finally {
    if ((await fs.realpath(intermediate)) === intermediate) await fs.rm(intermediate, { recursive: true, force: true });
  }
  const inventory = {
    schema: 1, product: associations.application, version, scope: details.scope, architecture: 'x64',
    upgradeCode: details.upgradeCode, productCode: definitions.ProductCode,
    package: { name: path.basename(output), sha256: await hash(output) },
    components: [
      { name: 'Electron', version: packageJson.devDependencies.electron, license: 'MIT' },
      { name: 'Wasmtime', version: '36.0.20', license: 'Apache-2.0 WITH LLVM-exception' },
      ...Object.entries(lock.packages).filter(([name, info]) => name.startsWith('node_modules/') && !info.dev)
        .map(([name, info]) => ({ name: name.split('node_modules/').at(-1), version: info.version, license: info.license ?? 'See bundled license' })),
    ],
    files: [],
  };
  for (const { name, file, bytes } of files) {
    inventory.files.push({ path: name.replaceAll('\\', '/'), bytes, sha256: await hash(file) });
  }
  await fs.writeFile(output + '.inventory.json', JSON.stringify(inventory, null, 2) + '\n');
  const bom = {
    bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: `urn:uuid:${randomUUID()}`, version: 1,
    metadata: { timestamp: new Date().toISOString(), component: { type: 'application', name: inventory.product, version,
      hashes: [{ alg: 'SHA-256', content: inventory.package.sha256 }] } },
    components: inventory.components.map(item => ({ type: item.name === 'Electron' ? 'framework' : 'library',
      name: item.name, version: item.version, licenses: [{ expression: item.license }] })),
  };
  await fs.writeFile(output + '.cdx.json', JSON.stringify(bom, null, 2) + '\n');
  return inventory;
}

async function build() {
  const version = process.argv[2] ?? packageJson.version;
  if (!msiVersion(version)) throw new Error('Use a Windows Installer version such as 0.1.0.');
  const output = path.join(dist, 'windows-installer', version);
  await fs.mkdir(output, { recursive: true });
  const tag = 'g11-' + randomUUID().slice(0, 8);
  await invoke(process.execPath, [path.join(repo, 'scripts', 'stage-windows-integration.cjs'), tag]);
  const staging = path.join(dist, 'windows-integration');
  const stage = path.join(staging, tag);
  try {
    for (const scopeName of ['account', 'machine']) {
      const filename = `VOKRI-Code-${version}-x64-${product[scopeName].suffix}.msi`;
      await buildMsi({ version, scopeName, stage,
        output: path.join(output, filename), signer: process.env.VOKRI_UPDATE_SIGNER_THUMBPRINT });
    }
  } finally {
    if ((await fs.realpath(stage)) === stage && path.dirname(stage) === staging) {
      await fs.rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
  console.log(output);
}

module.exports = { buildMsi, msiVersion, validateMsi };
if (require.main === module) build().catch(error => { console.error(error.message); process.exitCode = 1; });
