# G4 unified workspace and navigation shell

G4 runs in the Electron workbench with the approved Iris Ink design. Launch it with `npm start` on Windows. The editor gets the remaining width and height after the visible tools take their space. The Explorer and bottom panel can fold away, and the details panel starts closed.

## Screen map

| Area | What belongs there |
| --- | --- |
| Title bar | Current project, the Command Center, and direct Open, Save, Run, and Stop actions |
| Navigation rail and Explorer | Explorer, bottom panel and details toggles, project files, text search, and Settings |
| Center | Open file tabs, history, clickable folder breadcrumbs, and the source editor. The welcome view offers Open Folder, the built-in example, and recent projects |
| Workspace details | Project location, execution trust, active file, draft or recovery state, and Reveal in Explorer |
| Bottom panel | Run output, Problems, References, Terminal, Flightpath, Tasks, Recipes, Failure Lens, and Change Lens. Pin useful views beside Run output. Float the panel above the editor or dock it below |
| Status bar | Workspace trust, operation feedback, draft backup status, and the current editor state |

The same workspace identity and trust decision power the status bar, details, settings, and execution consent. Revoking trust updates the workbench and ends the existing grants through the normal broker and execution paths. Reopening a recent folder checks its recorded directory identity before switching. When leaving dirty files, Stay Here, Keep Drafts and Switch, and Discard and Switch are explicit choices. A failed switch keeps the current project and its drafts available.

The workbench saves Explorer width and visibility, details visibility, panel height, selected tool, pinned tools, and floating state in the current profile. Values are validated and clamped to the current window. At narrow widths the side panels overlay the editor. Reset Workspace Layout returns to the default layout. File tab pinning and drag order apply to the current session.

## Keyboard and command catalog

The Command Center, title bar, navigation rail, and shortcuts use the same action handlers. Commands appear when their actions are available in the current context. File search uses names and relative paths. Search Project finds text across source files and drafts.

| Action | Keyboard |
| --- | --- |
| Find files, switch mode to Projects, or type `>` for commands | Ctrl+P |
| Show commands | Ctrl+Shift+P or F1 |
| Select a Command Center result | Up, Down, Enter, Escape |
| Open project and save current or all files | Ctrl+O, Ctrl+S, Ctrl+Shift+S |
| Navigate the Explorer | Up and Down between rows, Right to expand or enter a folder, Left to collapse or go to its parent, Enter to open |
| Cycle or close open file tabs | Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+W |
| Move through editor navigation history | Alt+Left, Alt+Right |
| Search project text or declarations | Ctrl+Shift+F, Ctrl+T |
| Run file, run tests, or debug the active JavaScript file | F5, Ctrl+Alt+T, F6 |
| Go to definition or find references | F12, Shift+F12 |
| Toggle Explorer or bottom panel, show Problems, or focus Terminal | Ctrl+B, Ctrl+J, Ctrl+Shift+M, Ctrl+Backtick |
| Resize a focused Explorer or bottom panel separator | Arrow keys, Home, End |
| Settings | Ctrl+, |

Use the Command Center for **Open recent project**, **Reveal active file in Explorer**, **Go to run error**, **Pin or unpin active file tab**, **Move active file tab left/right**, **Pin or unpin current panel view**, **Float or dock bottom panel**, and **Reset workspace layout**.

## Evidence

- [Iris Ink Dark](evidence/g4/g4-04-iris-ink-dark.png) and [Iris Ink Light](evidence/g4/g4-05-iris-ink-light.png)
- [File search](evidence/g4/g4-02-file-search.png), [floating panel](evidence/g4/g4-06-floating-panel.png), and [compact workbench](evidence/g4/g4-07-compact.png)
- [High contrast](evidence/g4/g4-09-high-contrast.png) and [200% zoom](evidence/g4/g4-08-two-hundred-percent.png)
- [Recorded Windows keyboard journey](evidence/g4/g4-keyboard-journey.webm)

`npm run test:desktop` runs the Windows Electron journeys for first-run editing and error navigation, compact and restored layouts, trust updates, and failed workspace switching with drafts intact. The keyboard journey checks the Command Center's accessibility tree, including the expanded input and selected result. The compact checks use an actual 740 × 560 window and 200% Electron zoom. High contrast uses Chromium's forced-colors emulation.

On `43422d7`, the local Windows run passed 169 core and 92 desktop tests. A separate pointer-drag check passed for file tab order. The Windows Server 2025 reliability workflow passed, including credential separation, extension isolation, and the Intelligence benchmark. The native preview checks were skipped. [Windows reliability run](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43689226530)

For a focused run, use `node --test --test-concurrency=1 qa/workspace-shell.test.cjs` after `npm run build`. Set `VOKRI_G4_EVIDENCE` to an existing output directory for screenshots. To record the journey, install Playwright's FFmpeg with `npx playwright install ffmpeg` and set `VOKRI_G4_RECORD=1` for that run.

The project owner closed G4 on 2026-11-15 based on the automated Windows results and directed work to begin on G5. The evidence includes recorded keyboard journeys, accessibility-tree checks, and forced-colors coverage. Independent usability observation and a live screen-reader walkthrough were outside the evidence used for closure. [Phase 6 gate record](PHASE6_STATUS.json)
