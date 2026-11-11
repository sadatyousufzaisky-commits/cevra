# G5 · Capability & Consent Broker

Open a trusted workspace and choose **Extensions** in the status bar. For an installed, enabled executable package, **Review Permissions** shows its identity, exact archive digest, and requested file scopes in a native dialog. The grant lasts for the current host session. Workspace trust and extension consent are separate decisions. **Revoke Access** stops the host and clears its commands, diagnostics, and pending edits. [Extension Manager](g6-extension-manager.md)

The executable runtime is enabled on the verified Windows x64 builds 26100 and 26300. Safe start with `npx electron . --disable-extensions` suppresses extension execution and declarative contributions. Standard Windows x64 development builds prepare the pinned Wasmtime host alongside the workbench.

## Package and host contract

Declarative packages continue to use manifest v1. Executable packages use a v2 manifest and exactly two root ZIP entries in order, `extension.json` and `extension.wasm`. Both entries are at most 128 KiB and the archive is at most 256 KiB. The runtime descriptor is `{ "apiVersion": "0.1", "entry": "extension.wasm" }`. Permissions request each capability once and use explicit, canonical workspace file paths. `workspace.read` can separately request `drafts: true`. The package inspector checks the archive and module header. The confined host compiles and validates the module after consent.

The Wasm module exports `run() -> i32` and, if it registers commands, `command(handler: i32) -> i32`. Successful callbacks return zero. The only optional import is `cevra.request(input, length, output, capacity) -> i32`, using offsets in exported `memory`. It sends a JSON request over the private host pipe and returns the response length. Requests carry `protocol: 1`, `requestId`, `method`, and `params`. The broker binds authority to the pipe's session and treats the ID as correlation. File handles are opaque and session-scoped. Source text uses normalized line endings and revision-tagged UTF-16 offsets.

| Capability | Broker operations |
| --- | --- |
| `commands.register` | Register and unregister namespaced commands. The workbench invokes a registered handler on explicit action. |
| `diagnostics.publish` | Publish or clear bounded diagnostics for an authorized file handle and revision. |
| `editor.readSelection` | Read a bounded selection from an explicitly scoped active editor. |
| `workspace.read` | Read a named saved file and its revision. Open draft access requires a separate declared scope. |
| `editor.proposeEdit` | Queue a proposed replacement for an authorized file handle and revision. Review the diff and choose Apply as Drafts to accept. |

Main rechecks package bytes, workspace identity, trust, and the grant before operations and before delivering source. Revocation invalidates the grant and cancels pending work. A proposal acceptance uses the existing draft journal and rechecks the disk revision before its atomic commit. The workbench checks the open document version during review and application, so later changes expire the preview. The original file is updated by the ordinary Save action.

The host runs in the G3 Windows AppContainer and job. Requests are bounded to 256 KiB, responses to 1 MiB, and source snapshots to 512 KiB. Fuel, memory, deadlines, heartbeat, and per-session quotas bound resource use. The last 256 audit events are stored in `extensions/audit.json` under app data. Events include a package digest prefix, hashed workspace identity, operation, result, and duration. They omit source, paths, file handles, and arbitrary host parameters or output.

## Verification

Run `npm test` for broker, package, registry, and desktop regressions. Run `npm run test:extension-host` for the confinement suite and the real Electron journey with a compiled Wasm fixture. Tests cover allow, deny, revoke, replay, workspace replacement and switching, digest changes, stale previews, draft recovery, and audit privacy.

On 2026-11-11, implementation `1999c6f6e3ecc82f9238981302c4ed3105b831e1` passed 111 core, 66 desktop, and 13 extension host and runtime tests on local Windows 11 x64 build 26300 and hosted Windows Server 2025 x64 build 26100. The hosted run also exercised the clipboard confinement fixture. [Windows verification](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/42955384816)
