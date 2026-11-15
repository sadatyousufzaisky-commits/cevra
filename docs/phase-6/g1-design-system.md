# G1 Original design system

Iris Ink is the approved VOKRI Code direction. The workbench and Intelligence windows combine near-neutral surfaces with the VC mark’s iris accent and the 5 px button radius from Midnight Atelier. Explorer sits to the left of the editor, and the resizable output dock spans the full workbench width. These are the design system and reference workbench for the VOKRI SDK migration.

The workbench’s **Theme** menu offers **Iris Ink Dark**, **Iris Ink Light**, **System**, and **Midnight Atelier**. System follows the OS with Iris Ink colors. Midnight Atelier uses its original violet-tinted dark surfaces and is saved across restarts.

## Interactive proposals

Run `npm run build:design-preview` and open [the preview](design/preview.html) in a browser. Use **Direction** and **Appearance** to compare three implementations with the same files, actions, and simulated results. The preview keeps changes in memory and uses a simulated run with a fixed success or failure based on the selected file.

| Direction | Layout and appearance | Review trade-off |
| --- | --- | --- |
| Midnight Atelier (optional dark theme) | Left Explorer, violet-tinted graphite or platinum surfaces, iris action and selection indicators | The editor is the largest uninterrupted surface and the Explorer stays in its established position |
| Platinum Draft | Right Explorer, stronger blue-gray rules, wider surface tint steps and softer corners | The file list is accessible from the right, and the stronger chrome emphasizes panel boundaries |
| Iris Ink (approved) | Left Explorer, near-neutral surfaces, softly rounded controls and full-width run output | Errors and output get the full workspace width when they compete for attention |

## Tokens and component catalog

[Brand colors](../../src/brand-palette.css), [control tokens](../../src/design-system.css), and [file artwork](../../src/file-icons.js) are the source of truth. Native controls should use the same role names and maintain the behavior in this table. The current UI uses Segoe UI for controls and Cascadia Code or Consolas for source. Use 4, 8, 12, and 16 px spacing steps and a 5 px corner radius for controls and their surrounding frames in Iris Ink. Use 24 px minimum targets for compact controls and 33 px for standard buttons. Use 16 px file marks with unchanged filename announcements.

| Role | Tokens | Behavior |
| --- | --- | --- |
| Surfaces | `base`, `chrome`, `panel`, `raised`, `dock`, `line` | Source on base, navigation on chrome, contextual UI on panel. Use `line` for structural dividers. |
| Text and feedback | `text`, `muted`, `current-text`, `danger`, `warning`, `verified` | Keep feedback text explicit. Use visible status text for running, failed and completed runs. |
| Primary and secondary actions | `accent`, `ink`, `control-border`, `raised`, `button-hover`, `button-pressed`, `primary-hover`, `primary-pressed` | Sensible default action, distinct pointer hover and press, and visible keyboard focus. Disabled actions use dedicated fill, foreground and border. |
| Explorer and tabs | `selected`, `accent`, `current-text`, `icon-*` | Use leading or top indicators for the current file, `aria-current`, stable icon geometry, and an independent tab close target. |
| Form fields and dialogs | `control-border`, `focus-ring`, `focus-width`, `radius-control`, `radius-dialog`, `backdrop` | Keep labels connected to fields. Open modal dialogs with focus inside, and restore focus when canceled. |
| Loading and error | `accent`, `danger`, `error-surface`, `error-border` | Show progress with a written status and a marker. Stop its rotation under reduced motion. Show an error description and a source or retry action when available. |
| Forced colors | `Canvas`, `CanvasText`, `ButtonText`, `Highlight`, `HighlightText`, `GrayText` | Preserve focus, selection and icon geometry using the system palette. Use text to convey status. |

The main surfaces are `#131317` and `#ffffff`, the primary iris fills are `#b0a6ff` and `#5740b8`, and the interactive borders are `#8d88a5` and `#6d648b` in dark and light respectively. The icon catalog covers 25 illustrated categories, including the generic file fallback. Match conventional filenames and TypeScript declarations before ordinary extensions, case-insensitively. An icon identifies a file format. Editor language and runner support use their own capabilities.

The blueprint’s future component states include offline and unread navigation, pinned and dragged tabs, split panels, staged diff and review lifecycles, provider reconnect and consent, extension quarantine, and Settings search and reset. The applicable product gates implement and verify those states using this contract.

## Verification

`npm run build && npm run build:design-preview && node --test qa/design-system-desktop.test.cjs` runs the focused checks. Set `VOKRI_DESIGN_SCREENSHOTS` to an output directory to collect PNG evidence. The Windows tests cover case-insensitive and compound file matching, an unusual Unicode filename, a nested project, 16 px icons in the tree and tabs, an actual JavaScript failure and its navigation target, Settings focus return, and the design preview’s keyboard save, stop, and error navigation. They inspect the accessibility tree for dialog and form control names, verify Iris Ink’s full-width dock and matched corners, and check that Midnight Atelier persists and reaches Intelligence.

The contrast test reads the rendered palette and checks practical text and UI pairs against [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/). It enforces 4.5:1 for normal text and 3:1 for the audited non-text marks, control borders and focus rings. The snapshot matrix uses Electron’s Chromium device-scale emulation for 100%, 125%, 150%, and 200%. The forced-colors and reduced-motion tests exercise the corresponding Chromium media settings.

| Proposal | Dark text / non-text | Light text / non-text |
| --- | --- | --- |
| Midnight Atelier | 5.90:1 / 5.01:1 | 5.61:1 / 4.74:1 |
| Platinum Draft | 5.90:1 / 3.81:1 | 5.33:1 / 4.58:1 |
| Iris Ink | 5.90:1 / 5.22:1 | 5.65:1 / 4.86:1 |

Windows reliability passed on `5ff45de` with 167 core, 89 desktop, 18 extension-host and 13 Intelligence benchmark tests. Windows credential account separation also passed. A Windows process inventory command timed out in the initial extension-host run and succeeded on the rerun. [Passing Windows run](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43606774688/attempts/2)

See the [captured images](evidence/g1/) for the workbench, alternatives, and interaction states.

### Windows desktop walkthrough

On Windows 11 Home build 26300, the 1366 × 768 display offered 100% and 125% native scaling. At 125%, Electron reported a monitor scale and renderer pixel ratio of 1.25. In a fresh local profile, Explorer showed the file icons, a source edit saved to disk, F5 produced the expected error, the source link returned focus to the editor, and Settings applied an 18 px font and returned focus on Escape. The output dock spanned the viewport and the toolbar cleared the native caption controls by about 10 CSS pixels. The original 100% scale was restored. Higher-scale images come from the automated 150% and 200% snapshot runs. [125% workbench](evidence/g1/native-workbench-125.png) · [125% Settings](evidence/g1/native-settings-125.png)

Ten scripted Windows workflow checks passed locally on `462c1a1`. These exercised nested file saving, process start and stop, syntax and runtime error navigation, persistent settings, keyboard symbol search, provider consent, reviewed Intelligence edits, and verification and Git commit of a repair. The scripts verify task outcomes and record automated timings.

## G1 closure

The project owner approved Iris Ink and directed closure of G1 on 15 November 2026. The acceptance record includes Windows reliability, contrast, keyboard, and native 125% display evidence. The novice and experienced developer participant study and Windows Narrator smoke test were waived for G1. The workflow test results are scripted, and participant success rates were never collected.

## Participant study plan

Use a fresh sample for each participant. Record first attempt, completion without help, time to act, error or hesitation, and any inaccessible control. Report completed tasks divided by attempted tasks for each cohort.

- **New developer** opens a folder, identifies JavaScript and Python files, edits and saves, runs a file, follows a source error, and changes editor font size.
- **Experienced developer** finds a symbol, switches files, runs and stops a process, checks a failing source location, reviews a proposed change, and identifies the provider and consent before a request.
