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

Theme selection saves immediately, and **Reset Theme** restores Iris Ink Dark. **Reset layout** restores the default layout from the same command used by the Command Center. The Workspace category reports current execution trust and can revoke a grant. The existing execution prompt handles granting trust. Extension management and Intelligence links open their existing controls, including their usual permission and credential flows. Opening Settings leaves Intelligence in its current state.

## Profile compatibility and export

The control center reads the existing profile and preference keys in place. Missing or invalid editor values use application defaults. Existing per-workspace overrides remain active, and clearing an override removes that field from its workspace record. The preferences store serializes writes and atomically replaces the profile file. Directory identity and trust schema validation continue to govern any saved execution grant.

The **Export settings** picker writes a separate JSON file with `schemaVersion: 1`, the validated built-in `appearance.theme`, and the nine validated global `editor` values. The export uses an explicit field list. Credentials, provider configuration, extension and trust records, project paths, per-workspace overrides, and profile metadata stay in the profile.

## Verification

The Windows desktop tests exercise beginner and configuration-term search, keyboard focus, forced colors, 200% zoom, save and reset across restart, profile compatibility, the portable export, and navigation to existing extension and Intelligence settings. [Desktop regression tests](../../qa/settings-desktop.test.cjs)
