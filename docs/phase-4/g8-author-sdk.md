# G8 · Author SDK & Documentation

## Build and install your first extension

Run these PowerShell commands from the CEVRA source checkout with Node.js 24. Build the desktop app and its Windows hosts once with `npm run build`. The build prepares the pinned Zig compiler on Windows x64.

```powershell
npm ci
npm run build
npm run validate:extension -- examples/extensions/starter-tools/extension.json
npm run pack:extension -- examples/extensions/starter-tools dist/starter-tools.zip
npm run inspect:extension -- dist/starter-tools.zip
npx electron .
```

1. Open a folder with a JavaScript file. In the status bar, choose **Extensions → Choose ZIP Package** and select `dist/starter-tools.zip`.
2. Review **Starter Tools** and compare the SHA-256 with the inspection output. Choose **Install Package**, then **Enable**. This package declares zero permissions.
3. Close the manager. In a JavaScript file, type `cevrahell` and press **Ctrl+Space**. Choose `cevrahello` to insert the greeting. In **Theme → Extension editor palettes**, choose **Tideline**.
4. In the manager, choose **Disable**. The snippet disappears from completion and the editor returns to its built-in palette. Choose **Enable** to make the snippet and your saved palette available again.

The [Starter Tools manifest](../../examples/extensions/starter-tools/extension.json) is a template. Copy it into a new source folder and assign your own lowercase reverse-domain ID and version. The packer uses a new ZIP filename for each build.

## Build an executable command

Executable activation is supported on the verified Windows x64 builds 26100 and 26300. From the same checkout after the desktop build, run:

```powershell
npm run validate:extension -- examples/extensions/hello-command/extension.json
npm run build:extension-example
npm run pack:extension -- dist/extension-examples/hello-command dist/hello-command.zip
npm run inspect:extension -- dist/hello-command.zip
```

Install and enable **Hello Command** from that ZIP. With a workspace open, choose **Review Permissions**. Approve workspace trust if prompted, then review the package digest and approve **Add commands to Extensions**. Choose **Run Say hello** and confirm **Command completed.** Disable the extension to remove the command. Enable it and review permissions again to run it in a fresh session.

The sample contains a [manifest](../../examples/extensions/hello-command/extension.json) and [C source](../../examples/extensions/hello-command/command.c). The build stages only the manifest and compiled Wasm under `dist/extension-examples/hello-command`. To develop from this template, customize the manifest and source in your checkout, build again, and pack the staged files under a fresh ZIP filename. The [build script](../../scripts/compile-extension-wasm.cjs) records the freestanding `wasm32` target and linker flags.

## SDK interfaces

- [TypeScript declarations](../../sdk/extensions/contracts.d.ts) describe the manifest, permissions, and typed request and response payloads. Use `BrokerRequest<'commands.register'>` to check a registration message and `BrokerResponse<'commands.register'>` to model its reply. These are build-time types for author tooling. Validate actual data before using it.
- The [Node manifest validator](../../sdk/extensions/manifest.cjs) exports `validateManifest(bytes: Uint8Array): ExtensionManifest`. Pass the original UTF-8 bytes so duplicate keys and the size limit are checked. It uses CEVRA's package manifest parser and current engine version. It throws an error with a `code` on rejection. `npm run validate:extension -- <extension.json>` uses the same function and reports rejection with a nonzero exit status.
- The [C guest header](../../sdk/extensions/cevra.h) declares `cevra_activate`, `cevra_command`, and `cevra_request` with the Wasm export and import names. The guest serializes and decodes UTF-8 JSON. Compile as a core WebAssembly module with exported `memory` when using the broker. Return zero from successful callbacks.

### Compatibility

| Manifest | Package contents | Engine and runtime selection |
| --- | --- | --- |
| Schema 1 | `extension.json` | An inclusive lower and exclusive upper bound in `engines.cevra`. Declare an empty permissions array and at least one snippet or palette. |
| Schema 2 | `extension.json`, then `extension.wasm` | The same engine range, a runtime descriptor with `apiVersion: "0.1"` and `entry: "extension.wasm"`, and at least one declared capability. Declarative contributions are optional. |

Use numeric `MAJOR.MINOR.PATCH` versions and an engine range such as `>=0.1.0 <0.2.0`. Before installation, CEVRA selects the exact manifest schema, checks the editor version against the range, and checks the declared executable API version. API `0.1` uses broker protocol `1`. VS Code's extension ABI, VSIX packages, and the `vscode` module are outside CEVRA's compatibility contract. Port contributions into CEVRA's manifest and executable APIs. [Package format](g1-package-inspection.md)

### Activation, transport, and cancellation

Schema 1 contributions load after enablement. Schema 2 execution starts after workspace trust and per-session consent for the exact package digest. The host calls the `run() -> i32` export to activate. Register commands during activation and implement `command(handler: i32) -> i32` to handle the explicit run action. Use handler indices from 0 through 31. Register at most 16 commands at a time.

The only supported host import is `cevra.request(input, length, output, capacity) -> i32`. Pass byte spans in exported memory. The reply count excludes a terminating NUL. Give the response buffer enough space for the largest valid reply to your method. An invalid span or a reply that exceeds capacity traps the guest. Requests must be smaller than 256 KiB. Responses can be up to 1 MiB. The host also limits fuel, time, memory, and request counts. [Host limits](g5-capability-broker.md)

```json
{
  "protocol": 1,
  "requestId": "hello-1",
  "method": "commands.register",
  "params": { "id": "say-hello", "title": "Say hello", "handler": 0 }
}
```

Each request ID is unique per activation and contains 1–64 ASCII letters, digits, or hyphens. A response starts with `protocol`, `requestId`, and `ok`, followed by `result` or `error`. Match the request ID. An error response has `error.code` and `error.message`, and may have a null request ID for invalid input. Inspect `ok` before consuming a result.

Broker calls are synchronous from Wasm. Disable, revoke, workspace changes, and replacement invalidate the session and cancel pending host work. Commands, diagnostics, and pending edits are removed. The guest may be terminated without a callback. On activation, register contributions afresh and reacquire file handles and revisions. Treat the current session as the lifetime of those values.

### Capability and method reference

| Permission | Methods | Behavior |
| --- | --- | --- |
| `commands.register` | `commands.register`, `commands.unregister` | CEVRA namespaces the command ID. Keep the returned `registrationId` to unregister it. |
| `workspace.read` | `workspace.readFile` | Request a named file and `disk` or `draft` source. Draft reads require `drafts: true`. Returns text, source, path label, revision, and an opaque handle. |
| `editor.readSelection` | `editor.readSelection` | Read the selection in an explicitly scoped active editor. Returns selected text with a range and a handle for the full document revision. |
| `diagnostics.publish` | `diagnostics.publish`, `diagnostics.clear` | Publish up to 64 items for a file handle and expected revision. Clear removes the extension's diagnostics. |
| `editor.proposeEdit` | `editor.proposeEdit` | Submit replacement text for a file handle and expected revision. A successful reply queues a review. The user can apply it as an undoable draft and save it through the editor. |

Request each capability once. File scopes use explicit workspace-relative paths such as `src/demo.js`. Use forward slashes and the exact filename. Wildcards and parent segments are rejected. Snapshot text uses normalized line endings. Offsets are UTF-16 code units into the full document, including for diagnostics built from a selection.

Handle `PERMISSION_DENIED` and `UNAVAILABLE` by ending the affected operation. On `STALE_REVISION`, acquire a fresh snapshot and recompute any ranges or proposal. On `STALE_SESSION`, discard session state. Invalid requests and exhausted quotas can stop the host. Report command failure with a nonzero return code. Repair invalid input and retry with fresh consent after a host stop. Repeated host failures can quarantine a package. [Broker details](g5-capability-broker.md) · [Manager recovery](g6-extension-manager.md)

## Validate rejections

Copy the Hello Command manifest to a separate file, make one change per attempt, then run `npm run validate:extension -- <copy.json>`.

| Change | Expected error |
| --- | --- |
| Set `runtime.apiVersion` to `"1.0"` | `INVALID_MANIFEST` |
| Duplicate the `commands.register` permission | `INVALID_MANIFEST` |
| Replace permissions with `[{ "capability": "workspace.read", "files": ["src/*.js"] }]` | `INVALID_MANIFEST` |
| Set `engines.cevra` to `">=9.0.0 <10.0.0"` | `INCOMPATIBLE_ENGINE` |

Manifest validation covers manifest bytes and compatibility. Run package inspection after building to check the archive, its digest, and the module header. Executable behavior is verified by the confined host at activation.

## Privacy and migration

Start with schema 1 when snippets and palettes meet the need. Keep executable grants limited to the capabilities and named files the feature uses. Ask for draft access only when the feature needs unsaved text. Keep source, paths, and handle values out of command titles, diagnostics that could expose unrelated text, and troubleshooting reports. CEVRA's broker audit records bounded operation metadata and omits source contents and paths.

When updating, keep the package ID, increment its version, and publish the ZIP digest and any new scopes. For a schema 1 to schema 2 migration, retain contribution IDs where possible, declare the runtime and minimum permissions, and test both fresh install and update. A replaced version starts disabled and loses its old grant. Users can review the replacement and restore the previous version if needed. [Local distribution and updates](g7-local-distribution.md)

## Verification

`npm test` checks the declarations, validates both real manifests, exercises invalid author inputs, and verifies the packaged snippet and palette in Electron. `npm run test:extension-host` builds the example with the pinned compiler, packages it through the author CLI, installs it through the manager, and executes it twice with separate grants across disable and re-enable.
