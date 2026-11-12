const { spawn } = require('node:child_process');
const path = require('node:path');

const [folder, ...rest] = process.argv.slice(2);
if (rest.length || (folder && folder.startsWith('-'))) {
  console.error('Usage: npm run start:vokri -- ["project folder"]');
  process.exitCode = 2;
} else {
  const root = path.resolve(__dirname, '..');
  const profile = path.join(process.env.LOCALAPPDATA, 'CEVRA', 'Vokri');
  const app = spawn(path.join(root, 'dist', 'vokri', 'Vokri.Cevra.exe'),
    [process.execPath, root, profile, ...(folder ? [path.resolve(folder)] : [])], { windowsHide: true });
  app.once('error', () => { console.error('The Vokri workbench could not start.'); process.exitCode = 1; });
  app.once('exit', code => { process.exitCode = code ?? 1; });
}
