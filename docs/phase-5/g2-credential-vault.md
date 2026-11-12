# Phase 5 G2 — Credential Vault & Connections

## Manage an API key

Build on Windows x64 and launch the opt-in Intelligence preview.

```powershell
npm run build
npx electron . --enable-intelligence-mock
```

Open **Intelligence → Provider connections**. **Add key** opens a separate Windows password dialog for the selected provider. **Save Key** stores the value in Windows Credential Manager. The connection row then shows **Provider verification pending**. **Check key** checks the local entry and reports a missing key separately. G3 owns provider verification and live traffic.

**Replace key** asks for the new key. Cancel keeps the previous key. A successful replacement removes the retired key after committing the new reference. **Disconnect** asks for confirmation, then removes the local key from the current CEVRA profile. Provider-side key revocation remains available from the provider account.

The preview has one API-key slot each for OpenAI, Anthropic, and Gemini. Labels are built in. The native dialog accepts printable ASCII API keys of up to 2,048 characters without whitespace. Account and subscription authorization require a reviewed provider integration in a later gate.

## Trust boundary

The dedicated Intelligence preload exposes provider IDs, status, and explicit connection operations. The main process checks the top-level Intelligence sender and allows one connection operation at a time. The Windows helper owns native key input. It writes a generic Credential Manager entry with local-machine persistence for the current Windows user. It returns a fixed process status for save, cancellation, local check, and deletion. Keys stay outside Electron IPC, child-process arguments and environment, stdout, stderr, and preferences. The helper clears its owned key buffers after each operation. [Windows helper](../../src/intelligence/windows-vault.cs) · [Credential persistence](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw) · [Credential read scope](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw)

Vault targets include a hash of the canonical CEVRA profile path, provider ID, and a random generation reference. The profile stores only provider IDs and references in `intelligence/connections.json`. A copied metadata file in another profile addresses that profile's separate vault namespace. Checked reads reject malformed, oversized, or linked metadata. The native helper checks that the owning window still belongs to the expected process. Closing the Intelligence window or switching workspaces cancels its pending native prompt. [Connection manager](../../src/intelligence/connection-manager.cjs)

The mock adapter has no credential access. G2 provides native provision, check, and delete operations. G3 will need separately reviewed scoped access for the first live provider. The isolation claim applies to CEVRA's renderer and extension boundaries and to different Windows accounts. An equally privileged process in the same Windows account is outside the Credential Manager isolation claim.

## Interrupted operations

Before opening native entry, write a pending generation reference to the profile. Save the new key to that generation. On success, atomically promote the new reference and record the old generation for deletion. On cancel, remove the pending key and restore the previous metadata. If a crash or write failure interrupts the promotion, the pending reference identifies exactly which key to clean up. If removal fails, the metadata retains the interrupted state across restart.

Disconnect durably clears the active reference before deleting the key. **Clean up** retries pending deletion or discards an abandoned replacement and restores the prior configured state. Entries with incomplete operations block key checks until cleanup. Startup does not read keys or make requests.

## Verification

`node --test qa/intelligence-connections.test.cjs` exercises atomic metadata, interrupted rotation, concurrent requests, missing keys, linked files, and cleanup after deletion failure. After `npm run build`, `node --test qa/intelligence-vault-desktop.test.cjs` drives the real Electron connection UI and Windows password dialog with synthetic values. It verifies exact synthetic values through a test-only native probe, then checks cancellation, owner closure, rotation, restart, and removal. Both suites run under `npm test`. [Connection tests](../../qa/intelligence-connections.test.cjs) · [Native desktop test](../../qa/intelligence-vault-desktop.test.cjs)

Hosted Windows also creates a disposable standard user and verifies that two Windows accounts see separate values at the same synthetic vault target. The fixture removes its entries and the test account. The production helper has no test key injection or retrieval operation. [Hosted account test](../../qa/test-credential-account.ps1) · [Phase 5 ledger](PHASE5_STATUS.json)

On 2026-11-12, implementation `c9e42cc2260dcfd8a7beed93642c907faae311ee` passed 136 core, 77 desktop, and 17 extension-host tests on local Windows 11 x64 build 26300 and hosted Windows Server 2025 x64 build 26100. The hosted two-account check passed separately. [Windows verification](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43148330065)
