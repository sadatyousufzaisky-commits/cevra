const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('playwright');
const { ico, sizes } = require('./build-brand-icons.cjs');

const brand = path.resolve(__dirname, '../assets/brand');
const colors = { Code: '#A89AFA', Data: '#60CCA9', Web: '#7DB7FF', Text: '#E7AF73' };

async function build() {
  const logo = (await fs.readFile(path.join(brand, 'vc.svg'), 'utf8'))
    .replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const icons = Object.entries(colors).map(([category, accent]) => ({
    category,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="VOKRI Code ${category} document">
  <path fill="#191926" stroke="#0B0B13" stroke-width="8" stroke-linejoin="round" d="M46 14h111l57 57v147a18 18 0 0 1-18 18H46a18 18 0 0 1-18-18V32a18 18 0 0 1 18-18z"/>
  <path fill="#262438" stroke="#3F3A52" stroke-width="5" stroke-linejoin="round" d="M46 15h111l56 56v145a17 17 0 0 1-17 17H46a17 17 0 0 1-17-17V32a17 17 0 0 1 17-17z"/>
  <path fill="${accent}" d="M157 16v41a14 14 0 0 0 14 14h41zM49 205h143v10H49z"/>
  <svg x="40" y="60" width="165" height="135" viewBox="0 32 256 200">${logo}</svg>
</svg>`,
  }));
  const app = await _electron.launch({ executablePath: require('electron'), args: [require.resolve('./build-brand-icons.cjs')], chromiumSandbox: true });
  try {
    const page = await app.firstWindow();
    const rendered = await page.evaluate(async ({ icons, sizes }) => {
      function png(canvas) { return canvas.toDataURL('image/png').split(',')[1]; }
      const atlas = document.createElement('canvas');
      atlas.width = 648;
      atlas.height = 372;
      const ctx = atlas.getContext('2d');
      ctx.fillStyle = '#171722';
      ctx.fillRect(0, 0, atlas.width, atlas.height);
      ctx.fillStyle = '#EEEAF8';
      ctx.font = '600 22px Segoe UI, sans-serif';
      ctx.fillText('VOKRI Code document icons', 24, 38);
      const columns = [16, 24, 32, 48, 64];
      for (const [column, size] of columns.entries()) {
        ctx.font = '14px Segoe UI, sans-serif';
        ctx.fillText(size + ' px', 147 + column * 96, 73);
      }
      const items = [];
      for (const [row, { category, svg }] of icons.entries()) {
        const image = new Image();
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await image.decode();
        ctx.font = '600 16px Segoe UI, sans-serif';
        ctx.fillText(category, 24, 123 + row * 67);
        for (const [column, size] of columns.entries()) {
          ctx.drawImage(image, 165 + column * 96 - size / 2, 117 + row * 67 - size / 2, size, size);
        }
        items.push(sizes.map(size => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          canvas.getContext('2d').drawImage(image, 0, 0, size, size);
          return png(canvas);
        }));
      }
      return { items, atlas: png(atlas) };
    }, { icons, sizes });
    const folder = path.join(brand, 'documents');
    await fs.mkdir(folder, { recursive: true });
    for (const [index, { category, svg }] of icons.entries()) {
      const output = path.join(folder, category.toLowerCase());
      const pngs = rendered.items[index].map(item => Buffer.from(item, 'base64'));
      await Promise.all([
        fs.writeFile(output + '.svg', svg + '\n'), fs.writeFile(output + '.ico', ico(pngs)),
        fs.writeFile(output + '.png', pngs.at(-1)),
      ]);
    }
    const evidence = path.resolve(__dirname, '../docs/phase-6/evidence/g10');
    await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(evidence, 'document-icon-atlas.png'), Buffer.from(rendered.atlas, 'base64'));
  } finally { await app.close(); }
}

build().catch(error => { console.error(error.message); process.exitCode = 1; });
