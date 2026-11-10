# Phase 4 G2 — Registry and transactional storage

The internal registry stores verified, declarative G1 packages in `extensions/registry.json` under CEVRA's user-data directory. The caller supplies that directory from trusted app configuration. Use one owning process for a profile. The existing Electron single-instance lock is the ownership boundary for future workbench integration, and calls from registry clients in that process are serialized.

## Transaction and recovery

A snapshot contains a sorted index of installed extensions and immutable archive bytes keyed by SHA-256. Each installed entry has a current digest and at most one rollback digest. Keeping the index and referenced bytes together gives each mutation one commit point. The registry verifies the input against the digest approved at inspection and compares the installed digest before updating a record. It writes and flushes a temporary file beside the registry, then replaces the snapshot by rename.

On the next open after interruption, the registry reads the last committed snapshot and clears abandoned transaction files. An invalid schema, inconsistent inventory, or snapshot checksum mismatch fails closed and preserves the original file. An archive that fails its digest or G1 validation appears as failed and cannot be enabled. A verified rollback candidate remains available for explicit recovery.

The registry allows 64 installed extensions and 16 MiB of archive bytes across current and rollback versions. Base64 encoding and metadata add to the snapshot size. A write temporarily keeps both the committed snapshot and the staged copy. Recovery tests cover forced process termination on Windows.

## State and API

`createExtensionRegistry(userData)` is available from `src/extensions/registry.cjs`. First use can initialize an empty store.

| Operation | Behavior |
| --- | --- |
| `list()` | Read a deterministic list with current digest, version, enablement state and rollback metadata. |
| `install(file, { reviewedDigest, expectedCurrent })` | Revalidate the selected package. For a new installation, omit `expectedCurrent`. An update requires the exact current digest and saves one previous version. New installs and updates start disabled. Repeating a successful install of the same digest preserves its state. |
| `setEnabled(id, digest, enabled)` | Set the durable enablement preference for the current digest. Enabling requires intact, compatible bytes and a version outside quarantine. |
| `quarantine(id, digest)` | Disable and persist quarantine for that version. The quarantine flag stays with the digest through rollback. |
| `rollback(id, digest)` | Verify and restore the retained version in a disabled state. |
| `remove(id, digest)` | Remove the current and retained archives together with their registry entry. Retrying an already completed removal is safe. |

Enablement is a stored preference. Host activation and contribution registration belong to later gates.

## Verification

Run `npm run test:extensions`. The crash harness terminates a real child process before writing, during a partial write, after flushing the staged snapshot, and after commit. It does this for install, update, and removal. Each replay checks which digest survived, cleanup of abandoned files, idempotent retry, and preservation of the workspace fixture.
