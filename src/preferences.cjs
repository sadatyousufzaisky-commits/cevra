const fs = require('node:fs/promises');
const path = require('node:path');
const { writeAtomic } = require('./atomic-file.cjs');

const themes = new Set(['dark', 'light', 'system']);
const defaultTheme = 'dark';

function createPreferences(directory) {
  const file = path.join(directory, 'preferences.json');
  let loaded;
  let writes = Promise.resolve();

  async function read() {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch {}
    return {};
  }

  return {
    async getTheme() {
      await writes;
      const { theme } = await (loaded ??= read());
      return themes.has(theme) ? theme : defaultTheme;
    },
    async setTheme(theme) {
      if (!themes.has(theme)) throw new Error('Choose Dark, Light, or System.');
      const update = writes.then(async () => {
        const current = await (loaded ??= read());
        if (current.theme === theme) return theme;
        const next = { ...current, theme };
        await fs.mkdir(directory, { recursive: true });
        await writeAtomic(file, JSON.stringify(next, null, 2) + '\n');
        loaded = Promise.resolve(next);
        return theme;
      });
      writes = update.catch(() => {});
      return update;
    },
  };
}

module.exports = { createPreferences };
