const fs = require('node:fs/promises');
const path = require('node:path');

const brand = path.resolve(__dirname, '../assets/brand');
const sizes = [16, 24, 32, 48, 64, 128, 256];

function ico(images) {
  const directory = Buffer.alloc(6 + 16 * sizes.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + 16 * index;
    directory[entry] = directory[entry + 1] = size % 256;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(images[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  }
  return Buffer.concat([directory, ...images]);
}

if (process.versions.electron) {
  const { app, BrowserWindow } = require('electron');
  app.whenReady().then(() => {
    const window = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { backgroundThrottling: false } });
    return window.loadURL('about:blank');
  }).catch(() => app.exit(1));
} else {
  async function build() {
    const { _electron } = require('playwright');
    const app = await _electron.launch({ executablePath: require('electron'), args: [__filename], chromiumSandbox: true });
    try {
      const page = await app.firstWindow();
      const svg = await fs.readFile(path.join(brand, 'vc.svg'), 'utf8');
      const data = await page.evaluate(async ({ svg, sizes }) => {
        const image = new Image();
        image.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
        await image.decode();
        return sizes.map(size => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          canvas.getContext('2d').drawImage(image, 0, 0, size, size);
          return canvas.toDataURL('image/png').split(',')[1];
        });
      }, { svg, sizes });
      const images = data.map(base64 => Buffer.from(base64, 'base64'));
      await fs.writeFile(path.join(brand, 'vc.png'), images.at(-1));
      await fs.writeFile(path.join(brand, 'vc.ico'), ico(images));
    } finally { await app.close(); }
  }
  build().catch(error => { console.error(error.message); process.exitCode = 1; });
}
