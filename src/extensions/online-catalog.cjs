const { createPublicKey, verify } = require('node:crypto');
const { version } = require('../../package.json');
const { exactKeys } = require('./capabilities.cjs');
const { decodeCatalog, publisher, validateReleases, verifyRelease } = require('./catalog.cjs');
const { describePackage, sha256 } = require('./inspect-package.cjs');
const { checkEngine } = require('./manifest.cjs');
const { maxPackageBytes } = require('./package-zip.cjs');

const catalogOrigin = 'https://raw.githubusercontent.com/sadatyousufzaisky-commits/cevra/refs/heads/cevra/extension-catalog/v1/';
const signingKey = 'MCowBQYDK2VwAyEA6PhirAsjJUE2vLkHrTC4Sdh6+Law8lU0kzuuNEbuh1g=';
const source = 'Signed online catalog';
const maxEnvelopeBytes = 64 * 1024;

async function download(url, limit) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12_000) });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error('The catalog download is unavailable or exceeds its size limit.');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > limit) throw new Error('The catalog download exceeds its size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function signedCatalog(bytes, key) {
  const envelope = decodeCatalog(bytes);
  if (!exactKeys(envelope, ['payload', 'signature']) || typeof envelope.payload !== 'string' ||
      typeof envelope.signature !== 'string') throw new Error('Invalid catalog envelope.');
  const payload = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || !verify(null, payload, key, signature)) throw new Error('Invalid catalog signature.');
  const index = decodeCatalog(payload);
  if (!exactKeys(index, ['schemaVersion', 'generation', 'expiresAt', 'releases']) || index.schemaVersion !== 1 ||
      !Number.isSafeInteger(index.generation) || index.generation < 1 ||
      !Number.isSafeInteger(index.expiresAt) || index.expiresAt <= Date.now()) throw new Error('The signed catalog is invalid or expired.');
  validateReleases(index.releases, true);
  return { ...index, digest: sha256(payload) };
}

function createOnlineCatalog({ hostSupported, remember, fetchBytes = download, publicKey = signingKey }) {
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), type: 'spki', format: 'der' });
  let current;
  let loading;
  const unavailable = error => ({ source, hostSupported, entries: [], error });

  async function refresh() {
    current = undefined;
    let bytes;
    try { bytes = await fetchBytes(catalogOrigin + 'catalog.json', maxEnvelopeBytes); }
    catch { return unavailable('The online catalog could not be reached. Try again or choose Bundled.'); }
    try {
      const index = signedCatalog(bytes, key);
      const entries = index.releases.map(release => {
        let unavailable;
        try { checkEngine({ cevra: release.engine }, version); }
        catch (error) {
          if (error.code !== 'INCOMPATIBLE_ENGINE') throw error;
          unavailable = error.message;
        }
        return { ...release, publisher, unavailable };
      });
      await remember(index.generation, index.digest);
      current = { ...index, entries };
      return { source, hostSupported, entries };
    } catch {
      return unavailable('The online catalog failed verification. Choose Bundled or try again later.');
    }
  }

  return {
    list() {
      loading ??= refresh().finally(() => { loading = undefined; });
      return loading;
    },
    async select(id, digest) {
      const index = current;
      const release = index?.entries.find(entry => entry.id === id && entry.sha256 === digest);
      if (!release || release.unavailable || index.expiresAt <= Date.now()) {
        throw new Error('The online package is unavailable. Refresh the catalog to review it again.');
      }
      let archive;
      try { archive = await fetchBytes(catalogOrigin + 'packages/' + release.sha256 + '.zip', maxPackageBytes); }
      catch { throw new Error('The package download failed. Try again when the online catalog is available.'); }
      if (current !== index || index.expiresAt <= Date.now()) throw new Error('The catalog changed during download. Review the package again.');
      if (sha256(archive) !== release.sha256) throw new Error('The downloaded package failed its SHA-256 check.');
      const report = describePackage(archive);
      verifyRelease(release, report);
      return { archive, report, source, publisher, expiresAt: index.expiresAt };
    },
  };
}

module.exports = { createOnlineCatalog, signingKey };
