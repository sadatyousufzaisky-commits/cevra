# G7 · Local Distribution & Update

Build a local ZIP using Node.js 24 and the CEVRA repository.

```powershell
npm run pack:extension -- "C:\packages\source" "C:\packages\example.zip"
npm run inspect:extension -- "C:\packages\example.zip"
```

Put `extension.json` in the source folder. Add `extension.wasm` for schema v2. The packer validates the manifest and engine range, then writes the required entries in format order with fixed ZIP metadata and stored compression. Identical input bytes produce identical ZIP bytes across source locations and file timestamps. The command requires a new output filename and prints the archive SHA-256 and file inventory. The current inspector limits still apply to the generated ZIP.

Open **Extensions** and choose the ZIP. An update review shows the current and candidate versions, both digests, and changes to capabilities, file scopes, and open draft access. Same-version replacements and older versions have distinct approval buttons. An older package must pass the current engine and format checks before CEVRA offers **Install Older Version**.

**Pin Version** keeps the current digest selected across restarts. A pin blocks replacement and restore until you unpin it. Pin changes preserve the current enablement and running session. Uninstall remains available.

At install, the registry verifies the reviewed archive and compares the installed digest again. The atomic commit keeps the replacement and one retained version together. A rejected update preserves the installed version and any running host. A successful replacement starts disabled and revokes the previous host and grants. Enable it and review permissions again to activate an executable package.

**Restore Previous Version** verifies the retained bytes and digest before committing. The restored version starts disabled and retains any quarantine for that digest. A crash before commit preserves the installed package and its enablement. A crash after commit leaves the replacement disabled and its previous version available for restore.

## Verification

`npm test` checks reproducible packages, offline installation in Electron, pin persistence, permission review, incompatible and corrupt candidates, explicit downgrade, and recovery after terminating a process at each registry update checkpoint. `npm run test:extension-host` checks that a running extension survives an injected registry write failure and requires new consent after a successful update.
