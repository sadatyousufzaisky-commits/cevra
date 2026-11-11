# G6 · Extension Manager

Open **Extensions** from the status bar to manage packages with or without a workspace. **Choose ZIP Package** opens the Windows file picker. The review shows the source filename, extension ID, version, publisher verification status, SHA-256 digest, permissions, and package inventory. A replacement shows the installed version and permissions alongside the candidate.

Install the reviewed package, then choose **Enable** when ready. Declarative snippets and editor palettes become available after enablement. Executable extensions require a workspace and a separate permission review for each session. **Inspect** opens the verified details of the installed package.

**Disable** and **Uninstall** stop any running host and remove its commands, diagnostics, and pending proposals. **Quarantine** also prevents enablement until you clear it. Repeated host failures quarantine the affected package digest. **Clear Quarantine** verifies the package and leaves it disabled. **Restore Previous Version** restores the retained version in a disabled state, with any existing quarantine for that digest.

**Restart in Safe Mode** runs CEVRA's draft backup and close flow before restarting with extensions suspended. The manager stays available in safe mode, including when the registry cannot be read. **Restart with Extensions** returns to normal startup. Both modes preserve package enablement preferences.

Package operations use the existing atomic registry. CEVRA checks the selected bytes again at installation and requires the installed digest to match the version shown in the review. This gate covers management of local packages. Distribution policies and update verification continue in G7.

## Verification

`npm test` exercises the manager through Electron with the local ZIP picker and confirmation responses controlled by the tests. Coverage includes keyboard navigation and focus, accessible names and status messages, stale package rejection, update and restore, uninstall cancellation, registry errors, and safe-mode restart with draft recovery. The restart test checks the arguments sent to Electron and launches the next session with those arguments.

`npm run test:extension-host` exercises executable installation and consent through the manager, automatic quarantine after real confined host failures, recovery of an unsaved draft, and removal of a running extension.
