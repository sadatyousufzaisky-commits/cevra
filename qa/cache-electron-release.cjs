const { createRequire } = require('node:module');
const path = require('node:path');
const { version } = require('electron/package.json');

const electron = createRequire(require.resolve('electron/package.json'));
const { download, FetchDownloader } = electron('@electron/get');
const checksums = electron('./checksums.json');
const releases = 'https://api.github.com/repos/electron/electron/releases/';

async function downloadRelease(url, target) {
  const name = path.basename(new URL(url).pathname);
  const response = await fetch(releases + 'tags/v' + version, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('Electron release lookup returned HTTP ' + response.status + '.');
  const release = await response.json();
  const asset = release.assets.find(entry => entry.name === name);
  if (!asset) throw new Error('Electron release is missing ' + name + '.');
  const urlWithFreshRedirect = releases + 'assets/' + asset.id + '?download=' + Date.now();
  await new FetchDownloader().download(urlWithFreshRedirect, target, {
    headers: { Accept: 'application/octet-stream', Range: 'bytes=0-' },
    signal: AbortSignal.timeout(180_000),
  });
}

// Keep the installer's normal cache key and bundled checksum validation.
download(version, {
  checksums,
  cacheRoot: process.env.electron_config_cache,
  downloader: { download: downloadRelease },
}).catch(error => {
  console.error(error.response ? 'Electron release download returned HTTP ' + error.response.status + '.' : error.message);
  process.exitCode = 1;
});
