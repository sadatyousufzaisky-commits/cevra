# G9 Settings, personalization and control center

Open **Settings** from the left rail, the Command Center, or **Ctrl+,**. Search matches categories, setting names, descriptions, common phrases, and configuration terms such as `tabSize` and `formatOnSave`. The status-bar Theme and workspace trust buttons open the corresponding categories.

| Category | Settings and actions |
| --- | --- |
| Editor | Font, indentation, wrapping, line numbers, caret width, formatting on save, and Rename Symbol shortcut |
| Appearance | Built-in theme and enabled extension editor palettes |
| Workspace | Execution trust and reset of persisted panel sizes, visibility, and pinned views |
| Extensions | Installed packages, permission review, and the Extension Store |
| Intelligence | Provider connections, task model choices, Ollama, response preferences, and the daily estimate limit |
| Profile | Export portable settings and view product information |

## Defaults and scope

The [editor settings schema](../../src/settings-schema.cjs) defines each key, type, valid range or choices, default, and searchable terms. The workbench renders those fields from the schema and the main process uses it to validate writes.

Global editor values apply to every project. Each workspace can override individual fields. The control center shows the global value alongside a workspace override. **Reset** on a workspace row stages a return to inheritance. **Clear Workspace Overrides** stages that reset for all editor settings in the workspace. Global reset stages the application defaults. **Save Settings** commits the selected scope and applies the effective settings to open tabs. Switching scopes or changing the search keeps staged changes until you save or discard them.

Theme selection saves immediately, and **Reset Theme** restores Iris Ink Dark. **Reset layout** restores the default layout from the same command used by the Command Center. The Workspace category reports current execution trust and can revoke a grant. The existing execution prompt handles granting trust. Extension management and Intelligence links open their existing controls, including their usual permission and credential flows. Enable Intelligence from its status-bar control to access live settings.

## Profile compatibility and export

The control center reads the existing profile and preference keys in place. Missing or invalid editor values use application defaults. Existing per-workspace overrides remain active, and clearing an override removes that field from its workspace record. The preferences store serializes writes and atomically replaces the profile file. Directory identity and trust schema validation continue to govern any saved execution grant.

The **Export settings** picker writes a separate JSON file with `schemaVersion: 1`, the validated built-in `appearance.theme`, and the nine validated global `editor` values. The export uses an explicit field list. Credentials, provider configuration, extension and trust records, project paths, per-workspace overrides, and profile metadata stay in the profile.

## Verification

The Windows desktop tests exercise beginner and configuration-term search, keyboard focus, forced colors, 200% zoom, save and reset across restart, profile compatibility, the portable export, and navigation to existing extension and Intelligence settings. [Desktop regression tests](../../qa/settings-desktop.test.cjs)

On Windows 11 x64 build 26300, revision `8c8e44cb8f99b9752b436f11173dbc808d0fece1` passed 173 core tests and 108 desktop tests across two runs. A local test process exited before reporting the workbench cases, and all 66 of those cases passed on the isolated rerun. The screenshots show a beginner query in Iris Ink and an advanced query in forced colors at 200% zoom. [Beginner search](evidence/g9/beginner-search.png) · [Advanced search at 200%](evidence/g9/advanced-search-200.png)

## Gate decision

G9 passed on 2026-11-16 for the Electron workbench. The final revision passed 173 core tests and 108 desktop tests together on Windows Server 2025. Credential account isolation, 19 extension-host tests, and 13 Intelligence benchmark checks also passed. The optional native profile-handoff test was skipped. [Phase 6 status](PHASE6_STATUS.json) · [Windows reliability run](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43794028270)
