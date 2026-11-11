# G4 · Contribution APIs

## Declarative contributions

CEVRA reads contributions from explicitly enabled packages in the app-data registry. The registry checks each current archive against its stored digest, manifest identity, and engine range before returning snippet text and palette colors. The workbench refreshes after registry commits and revokes the affected extension's contributions while it verifies the new snapshot. A corrupt registry leaves the built-in editor available. A workspace ZIP gains no registrations by being opened or present in the project.

- **Snippets** appear in editor completion for their declared language. Type a prefix or press Ctrl+Space to browse. Matching prefixes from different providers have distinct extension and snippet IDs. JavaScript and TypeScript keep semantic completions alongside snippets. Choosing a snippet inserts literal text as one undoable editor change, with normal draft and save handling. File language selection covers JavaScript, TypeScript, Python, JSON and JSONC, Markdown, and plain text.
- **Palettes** appear under Extension editor palettes in the Theme menu. The palette colors apply to the editor and gutter. CEVRA stores the choice for the exact extension digest and palette ID. Disable, quarantine, update, or uninstall restores the previous CEVRA Dark, CEVRA Light, or System choice. Enabling the same digest makes its saved choice available again. Choosing a built-in theme clears the saved extension choice.
- **Safe start** uses `npx electron . --disable-extensions` after building. This suppresses snippets and palettes for the session and preserves installed enablement and preferences.

## Verification

Run `npm test` on Windows. Registry tests exercise digest verification, revocation, rollback, and profile-scoped notifications. Electron tests cover language filtering, duplicate snippet prefixes, semantic completion, literal insertion and undo, live removal, palette persistence and fallback, safe start, and editing with a damaged registry.

Implementation `6c73f28fd4c48ab657aafd374896ae8b88cd9d62` passed 78 core tests, 66 desktop tests, and six isolation tests locally on Windows 11 x64 build 26300 and in hosted Windows Server 2025 x64 build 26100. The hosted run also checked the isolated host's clipboard fixture. Verification completed on 2026-11-11. [Windows verification](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/42949730680)

The extension registry is managed through the internal API until G6. G4's remaining acceptance work uses the G5 capability broker for commands, scoped diagnostics, and revision-checked edit proposals.
