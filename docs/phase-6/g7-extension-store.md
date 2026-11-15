# G7 VOKRI Extension Store and Manager

Open **Extensions** and choose **Browse Catalog**, or run **Extension Store** from the Command Center. Search by name, publisher, description, or extension ID and filter by category. The store starts with **Online** selected. Choose **Bundled** for the offline catalog, or open **Installed** to choose a ZIP or manage existing extensions.

**Download & Review** fetches a package and shows its publisher attribution, version, engine compatibility, SHA-256, inventory, and permissions. Select **Install Package** to install it in a disabled state. An available update shows the installed version and changes to requested capabilities. Updating also starts the new version disabled. The installed view retains the previous version for rollback, respects version pins, and offers safe-mode restart, quarantine, and removal.

Starter Tools adds a JavaScript snippet and an editor palette. Hello Command is a Wasm extension that registers a command without requesting source access. The signed launch catalog lists these two VOKRI Code project releases. [Published catalog branch](https://github.com/sadatyousufzaisky-commits/cevra/tree/cevra/extension-catalog/v1)

## Registry contract

- The Electron main process fetches one HTTPS feed from the public release branch. It refuses redirects and bounds request time, catalog size, and ZIP size.
- The feed contains an Ed25519 signature over a versioned payload. The app pins the public key, checks the expiration and monotonic generation, and persists the highest accepted generation and digest in the profile. The signing key stays outside the repository, protected by Windows DPAPI for the current Windows account.
- The app derives a package URL from the SHA-256 in the signed index. It checks the complete bytes against that digest and compares the inspected package identity, version, compatibility, and permission count against the signed metadata before presenting the review. The stored review is tied to the main window, exact bytes, installed digest, and feed expiration.
- Catalog signing authenticates package metadata published by the VOKRI Code project. A manually selected ZIP continues to show unverified publisher identity. The store never automatically installs or enables a package.
- An unreachable, invalid, or expired online catalog leaves Bundled, Installed, and ZIP installation available. A missing or mismatched bundled ZIP remains visible with an error and its installation action is unavailable.

## Host compatibility

Declarative packages add data such as snippets and palettes. Executable packages need a trusted workspace and a separate capability grant for the current session. The store uses the existing broker and Less Privileged AppContainer/Wasm host with the same file scopes, revocation, quarantine, and credential boundaries.

| System | Executable extension policy |
| --- | --- |
| Windows 11 x64 build 26300 | Confined host verified locally. |
| Windows Server 2025 x64 build 26100 | Confined host exercised by the Windows reliability workflow. |
| Other OS releases and architectures | The runtime gate permits only Windows x64 reporting build 26100 or 26300. Other configurations cannot activate executable extensions. |

See the host evidence for process, clipboard, filesystem, and capability enforcement. [Phase 4 isolation](../phase-4/g3-extension-host-isolation.md) · [Capability broker](../phase-4/g5-capability-broker.md)

## Publishing

Build the project and run `npm run build:extension-example`, followed by `node scripts/pack-extension-catalog.cjs`, to regenerate the tracked bundled ZIPs and their index. Review the resulting package inventory and changes before publishing.

From the application checkout, run `pwsh -File scripts/sign-extension-catalog.ps1 -Destination <catalog-checkout>/v1 -Generation <next-number>` under the Windows account holding the protected signing key. The signer checks the key matches the one pinned in the app. Review and commit the public envelope and digest-named ZIPs on `cevra/extension-catalog`. Existing published package paths remain valid when the catalog changes. Use a new generation whenever the signed index changes. The default signed lifetime is 180 days. Publish a new generation before it expires.

## Verification

`npm test` covers signed-index tampering, replay, expiration, ZIP digest mismatch, unsupported activation, offline discovery, permission review, update, rollback, and an unavailable catalog. `npm run test:extension-host` exercises the bundled executable through the confined host after separately approving its permissions. To check the public feed with real HTTPS downloads, build the app and run `node --test qa/extension-store-online.test.cjs`.

The manager test uses the editor and accessibility tree to verify keyboard focus, searchable and filtered entries, permission heading and list, and return to the reviewed package. [Catalog and integrity tests](../../qa/extension-packaging.test.cjs) · [Manager tests](../../qa/extension-manager.test.cjs) · [Live online test](../../qa/extension-store-online.test.cjs)
