# G0 · Complete identity transition

The app is **VOKRI Code**, the framework is **VOKRI**, the assistant is **VOKRI Intelligence**, and the compact emblem is **VC**. The identity applies to the current Windows workbench, companion panel, native credential prompt, About dialog, package metadata, and Windows helper executable resources. The taskbar identity is `Vokri.Code`. [Identity contract](brand-identity.json)

The built-in light and dark themes use the VC mark’s iris and cool platinum across the editor, workbench, and Intelligence. Confirmed results use a separate platinum tone. Amber and coral preserve warning and error distinctions. Terminal ANSI colors still express the color selected by command output. Extension themes keep their authored palettes. [Theme tokens](../../src/brand-palette.css)

Measured text contrast is 16.88:1 in dark and 14.99:1 in light. Primary action label contrast is 7.70:1 in dark and 7.42:1 in light. These measurements cover the specified color pairs. The broader component and accessibility audit belongs to G1. [Dark workbench](evidence/workbench-dark.png) · [Light settings](evidence/workbench-light.png) · [VC icon atlas](evidence/vc-icon-atlas.png)

## Profile continuity and rollback

| Profile state | Launch behavior |
| --- | --- |
| Fresh launch | Create `VOKRI Code` under Electron's platform AppData directory. |
| Existing CEVRA profile only | Use the original directory in place. About reports that the existing profile is active. |
| Both profiles exist | Use the VOKRI Code directory. About reports that the earlier profile is preserved separately. |
| Explicit `--user-data-dir` | Use the selected directory. This can reopen either existing profile. |

Credential Manager targets incorporate the canonical profile directory. In-place compatibility preserves the existing key, settings, drafts, trust records, extensions, and usage ledger without a copy or a vault re-enrollment. It also lets the Phase 5 baseline reopen the legacy directory for rollback. Close the running app before switching builds. If both directories exist, launch with `--user-data-dir` pointing at the earlier directory to recover that profile. Neither directory is merged or deleted by the transition.

The local rollback replay opened the same fixture in VOKRI Code twice and then reopened it with Phase 5 commit `4b7a404819a3a8db0535134152636b9255fa2e34`. The old build recovered the draft, loaded the light theme, and checked the same key in Windows Credential Manager. To repeat, set `VOKRI_IDENTITY_ROLLBACK_ROOT` to a built checkout of the pinned Phase 5 revision and run `node --test qa/identity-desktop.test.cjs` after building G0.

## Identity inventory

| Surface | G0 decision |
| --- | --- |
| Workbench, About, Intelligence, and permission copy | VOKRI identity applied. Existing product features and consent scopes are preserved. |
| Desktop icon | Original transparent VC monogram, monochrome variant, and seven Windows ICO sizes from 16 to 256 px. Regenerate with `node scripts/build-brand-icons.cjs`. |
| On-disk data | Existing profile paths, vault target prefix, project configuration names, and draft/registry formats remain compatibility contracts. |
| Extensions | The current authoring UI uses the new product name. Existing package identifiers, `engines.cevra`, the Wasm import name, and the broker protocol remain valid. |
| Repository | The npm package uses `vokri-code`. The public repository URL and Phase 1–5 history retain their existing names. |
| Native SDK | The Phase 5 workbench and the VOKRI SDK are pinned separately. Native SDK completion and the native application executable belong to G2–G3. |
| Windows shell and installer | G0 provides the VC icon and application identity. Explorer language icons and file associations are verified with G10. Installer, installed shortcuts, signing, and setup verification belong to G11. |

The identity scan covers current source and build entry points. Historical evidence, legacy profile selection, vault target identifiers, workspace settings, internal IPC, and extension compatibility tokens retain their existing values. [Identity tests](../../qa/identity-desktop.test.cjs)

## Windows verification

Windows CI passed 167 core, 86 desktop, 18 extension-host, and 13 benchmark checks. Credential Manager account isolation passed separately. Local Windows verified the profile transition and rollback. The Windows shortcut fixture verified the icon path and application ID. The native helpers reported VOKRI Code as their product in Windows file metadata. [Windows CI](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43600144627)

The build and test evidence are ready for owner review. The G0 ledger retains the owner signoff checkpoint for the artwork and compatibility approach. [Phase 6 ledger](PHASE6_STATUS.json)
