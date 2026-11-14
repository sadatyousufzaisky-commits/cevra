# Phase 5 G5 — Editor Actions & Patch Review

Build CEVRA and launch the opt-in Windows preview with `npx electron . --enable-intelligence`. Open a project, attach an editor selection or saved file, and select the OpenAI model. Describe the change you want and choose **Propose edits**. The outbound review includes the exact context, response preferences, and proposal instructions sent to the provider.

A valid selection proposal appears inline with a short preview. Choose **Review Intelligence edit** in the workbench to inspect the complete before-and-after text for every file. **Apply as Drafts** creates a recoverable batch with one undo step per file. **Save** updates the original files through the normal editor flow. **Dismiss Intelligence edit** removes the proposal.

## Approval and source checks

The model returns a bounded JSON record with replacement text and opaque IDs for the sources supplied in the request. CEVRA resolves each ID to the original selection range or saved file. It rejects unknown IDs, duplicate file targets, instruction-file edits, malformed output, and truncated proposals. Each proposal permits one replacement per file. The parser accepts up to 24 KiB of response JSON and applies the editor's normal draft size limit.

CEVRA checks the original disk revision and file identity, plus the editor document ID, version, and buffer contents when available. A saved-file replacement requires a clean editor buffer. Attach a selection to propose changes to an unsaved buffer. The draft journal rechecks the approved batch immediately before committing it. A stale target rejects the batch as a unit. CEVRA preserves the buffer's byte-order mark and line ending. Files with mixed line endings require normalization before review.

Proposals expire after ten minutes. A new approved request, a changed target buffer, a workspace switch, panel closure, or OpenAI connection revocation retires the current proposal. Provider output supplies text only. The patch workflow uses existing files and does not invoke the runner.

## Verification

`npm test` exercises the proposal broker and the Windows desktop workflow. The fixtures cover invalid source IDs, duplicate targets, exact approval, a disk change at the journal boundary, and revocation. The desktop test uses a synthetic provider response and the real Windows credential vault. It verifies the inline hint, keyboard diff review, cancel and apply, Undo, stale multi-file rejection, and recovery after a forced restart. This gate is available in the Electron workbench.

On 2026-11-14, the implementation passed 149 core, 80 desktop, and 17 extension-host tests on hosted Windows Server 2025 x64 build 26100. The credential account isolation check also passed. [Windows verification](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43549718544)
