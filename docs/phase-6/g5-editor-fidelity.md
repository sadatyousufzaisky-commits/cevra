# G5 professional editor experience

G5 brings editing, navigation, and review into the Electron workbench and preserves source bytes across saves, formatting, project edits, and recovery.

| Workflow | Behavior |
| --- | --- |
| Edit and save | Preserve the UTF-8 BOM and the original LF, CRLF, and CR separators that survive the edit. New separators follow the file's preferred style. |
| Change line endings | Select the line-ending indicator in the status bar, or search for **Convert line endings** in the Command Center. Choose LF, CRLF, or CR. Undo or redo the conversion like any other edit. |
| Format | Preserve surviving separators by default. An explicit `.cevra-format.json` line-ending setting converts the document within the same undo step. |
| Run editor commands | Open the Command Center with **Ctrl+P** and enter **>** to find Undo, Redo, Find, Replace, Go to Line, fold and unfold, line comments, and multiple-cursor commands. |
| Review a draft | Run **Review Unsaved Changes** to compare the active buffer to its last verified disk revision. The read-only view moves between changes and reports BOM or line-ending changes even when the displayed text is identical. |
| Apply project edits | Project replacement and Rename Symbol check all source revisions before recording one recoverable batch. Unchanged separators and the BOM are preserved, including in files with mixed line endings. |
| Recover a draft | Restore the saved draft bytes after a crash. If the original changed on disk, **Save recovery copy** writes a separate file. |
| Reject unsupported input | The editor reports invalid UTF-8 and the existing 2 MiB limit. Saving rejects malformed Unicode that would otherwise be replaced by an encoding conversion. |

The editor uses normalized positions for selections, diagnostics, and language-service requests. It retains the original separators in the document state and uses them when writing a draft or saving to disk. Converting line endings refreshes diagnostics and language-service requests for the new revision. If an edit puts a standalone CR and LF immediately next to each other, the second separator becomes CRLF so reopening retains both lines.

The status bar shows **Mixed EOL** when the buffer retains exceptions to its preferred style. The separate Intelligence edit broker requires a uniform line-ending style. Ordinary typing groups draft backup work in 100 ms windows. Closing, switching projects, and saving still wait for pending draft work where required. Forced crash recovery uses the last completed backup.

## Phase 2 workflow review

| Workflow | Regression coverage |
| --- | --- |
| Editor and document state | Switching tabs retains drafts and undo history. In-file replacement checks case and whole-word matching and undoes as one edit. G5 also exercises commands, multiple cursors, folds, and read-only review. |
| Project search and replacement | Nested files and unsaved versions are searchable. Navigation restores previous positions, obsolete disk matches are rejected, and approved replacements recover together after a crash. G5 adds crash replay on two files with mixed line endings. |
| JavaScript and TypeScript assistance | Semantic completions, hover, and signature help use unsaved imports. Stale results are ignored after edits, caret movement, and tab switches. Syntax and type diagnostics open the exact range. |
| Project navigation and rename | Go to Symbol, Go to Definition, Find References, and Back and Forward cover open drafts and files on disk. Rename previews cross-file edits, rejects collisions, and preserves per-file undo. |
| Formatting, preferences, and recovery | Formatting uses the current buffer and project preferences, preserves selection, and groups changes in one undo step. Global and workspace editor preferences are exercised with open tabs and across restarts. Recovery protects externally changed or deleted originals. |

The review uses the existing [core](../../qa/core.test.cjs) and [desktop](../../qa/workbench.test.cjs) regression suites and the new [G5 editor scenarios](../../qa/editor-experience.test.cjs).

## Verification

`npm run test:core` exercises a seeded mixed-ending corpus with Unicode text, undo and redo, grouped deletion, and unsupported save input. `npm run test:desktop` exercises byte-for-byte saves and recovery through real Windows Electron windows, including BOM, right-to-left text, emoji, a forced app crash, a formatter conversion, and an externally changed original. The checks cover undo of both direct and formatter conversions.

The [editor benchmark](evidence/g5/editor-benchmark.json) measures 25 typing and eight scrolling samples on a three-tab fixture with an 834,438-byte source file, 24,002 lines, a 65,536-character line, and 2,850 diagnostics. On Windows 11, the 95th percentile to the next completed animation frame was 32.1 ms for typing and 33.4 ms for scrolling. The measured renderer heap after forced collection grew 266,528 bytes after five tab cycles. The test also verifies undo. These measurements characterize this fixture and machine.

The automated desktop test exercises composition commit, cancellation, undo, redo, and multilingual save through Chromium. The [live Windows test](../../qa/editor-live-ime.test.cjs) recorded trusted preedit events from Vietnamese Telex, committed `ấ`, verified undo and redo, and checked the exact resulting bytes in a UTF-8 file with a BOM and mixed separators. The [recorded result](evidence/g5/live-ime.json) includes the trust flags for each observed composition stage.

To repeat the live check, build the app with `npm run build`, select the Windows Vietnamese Telex input method, set `$env:VOKRI_G5_LIVE_IME = '1'`, and run `node --test qa/editor-live-ime.test.cjs`. After `G5_LIVE_IME_READY` appears, type **A**, **A**, **S**, then **Space** in the test window. The helper uses a temporary workspace and profile.
