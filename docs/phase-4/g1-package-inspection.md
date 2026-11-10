# Phase 4 G1 — Package and manifest inspection

Use Node.js 24 to inspect a local package from the CEVRA repository.

```powershell
npm run inspect:extension -- "C:\path\to\package.zip"
```

The command returns JSON with the validated manifest, CEVRA engine version, archive SHA-256, and an inventory containing the manifest's byte count and SHA-256. The publisher field reports `unverified`. A digest establishes the identity of the reviewed bytes. Package format or manifest errors produce a bounded message, an error code, and a nonzero exit status. The same implementation is available internally as `inspectExtensionPackage(filename)`.

## Package format v1

The archive contains exactly one regular file named `extension.json` at the ZIP root. Store or DEFLATE the file. Use a single disk, standard ZIP headers, and an exact match between the local and directory records. The only optional ZIP flag is the UTF-8 filename flag. Encryption, data descriptors, ZIP64, entry extras, comments, links, and additional files are outside this format. Inspection caps the archive at 256 KiB and the uncompressed manifest at 128 KiB, verifies CRC32, and checks that the DEFLATE stream consumed the entire declared payload. [ZIP format](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) · [Node.js zlib](https://nodejs.org/docs/latest-v24.x/api/zlib.html)

The inspector opens a selected regular file read-only and checks its identity before and after reading. On Windows, use a drive-letter path. Junction paths, symbolic links, hardlinks, device names and alternate data streams are rejected. The archive stays in memory. This gate provides inspection only.

## Manifest schema v1

```json
{
  "schemaVersion": 1,
  "id": "org.cevra.hello",
  "version": "1.0.0",
  "displayName": "Hello",
  "description": "A starter JavaScript snippet",
  "engines": { "cevra": ">=0.1.0 <1.0.0" },
  "permissions": [],
  "contributes": {
    "snippets": [
      { "id": "say-hello", "language": "javascript", "prefix": "hello", "body": "console.log('Hello');" }
    ]
  }
}
```

Save the example as UTF-8 without a BOM and archive just that file. Windows PowerShell can create the ZIP with `Compress-Archive -LiteralPath .\extension.json -DestinationPath .\hello.zip`.

- The manifest uses schema version `1` and a lowercase reverse-domain ID. The package version and engine bounds use three numeric components of up to nine digits each, with no leading zeroes. The engine range uses the exact `>=MIN <MAX` grammar and includes the lower bound. The CEVRA build version must fall below the upper bound.
- `permissions` is an empty array. `contributes` can contain `snippets`, `themes`, or both. Every other field at every level is rejected.
- A package can declare up to 32 snippets. Each has `id`, `language`, `prefix`, `body`, and an optional `description`. Supported languages are JavaScript, TypeScript, Python, JSON, Markdown and plaintext, using lowercase values.
- A package can declare up to eight themes. Each has `id`, `label`, and a `colors` object with exactly `background`, `foreground`, and `accent` as literal `#RRGGBB` colors.
- Contribution IDs are lowercase slugs and unique within their contribution type. The inspector rejects duplicate JSON keys, nesting deeper than eight containers, invalid Unicode, and control or direction characters. Snippet bodies may contain tabs and line endings and are capped at 2,048 UTF-16 code units.

## Verification

Run `npm run test:extensions` for the inspection tests. They cover independent snippet and theme fixtures, malformed manifests and archives, file identity and path handling, and the absence of workspace, package store, and extraction side effects. The Windows reliability workflow includes the suite through `npm test`.
