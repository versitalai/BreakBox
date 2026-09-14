# BreakBox Regression Fix Plan

Last updated: 2026-09-13
Branch: `revamp`
Live deployment: https://versitalai.github.io/BreakBox/

## 1. What was broken

Two regressions after the latest deployment:

1. Notes could not be removed, even by clicking an existing note again.
2. Song playback did not start at all.

The editor otherwise appeared to render, so this was not a “blank page” problem at that point.

## 2. Root causes

### 2.1 Note removal

Symptoms were consistent with an undoable-change ownership failure in `PatternEditor`.

- Mouse press constructs a new `ChangeSequence`.
- Changes are applied immediately by the change constructors.
- If the constructed sequence is never assigned to `_dragChange`, the pending drag work is lost.
- Mouse release then has no recordable sequence, so deletions/additions do not commit.
- Clicking an existing note therefore had no active sequence with which to remove it.

### 2.2 Playback

The second regression was worse than a UI-only issue.

- The incomplete AudioWorklet path had become the production audio default.
- That worklet path is a scheduling scaffold only and cannot render complete songs today.
- The editor still expects a full synth implementation (`playing`, timeline tracking, effects, transport state).
- So the editor could appear mounted while playback was non-functional.

## 3. Fixes made

### 3.1 Editor interaction

- `PatternEditor._whenCursorPressed` now assigns the newly created `ChangeSequence` to `_dragChange` before calling `setProspectiveChange`.
- That restores the pending change that mouse release expects to record.

### 3.2 Playback architecture

- `editor/main.ts` no longer registers `WorkletSynthAdapter` as the default audio engine.
- `SongDocument` defaults to `LegacySynthAdapter(this.synth)` when no engine is explicitly registered.
- AudioWorklet remains available for future explicit experimentation, but it is not the production path today.

### 3.3 Build and deployment cleanup

- Fixed Terser `--source-map` invocation so the production build scripts can complete.
- Fixed the `EditorConfig.js` compiled entry so `website-editor-config` can build correctly.
- Updated `service_worker.js` to use scope-relative `./...` URLs for project Pages, bumped its cache name, and added old-cache cleanup.
- Noted that stale user-side caches can make an old broken version survive a deploy; the cache version bump helps.

### 3.4 Regression prevention notes

- Do not validate after the fact solely by checking that the editor mounted.
- After changes to pattern editing or audio routing, test the actual browser behaviors:
  - click empty space to create a note
  - click the created note to remove it
  - press Play and confirm transport changes state
  - press Pause and confirm transport returns

## 4. Current verification status

All of the following were confirmed after the fixes:

- Local and public GitHub Pages build success.
- Editor mounts and renders normally.
- Note creation and removal work in the browser.
- Play/pause transport works in the browser.
- Production bundles rebuilt.
- Tests pass.
- Live Pages deployment confirms the corrected revision.

## 5. Optional follow-ups

### 5.1 Automated regression coverage — in progress

- Added `tests/editorRegression.test.ts` to protect the two exact root causes:
  - Pattern-editor mouse presses retain the same `ChangeSequence` as the pending drag change.
  - `SongDocument` uses `LegacySynthAdapter` backed by its own complete `Synth` when no experimental engine is registered.
- Added a jsdom-compatible test mock for the editor's ESM-only DOM helper so editor-state tests can execute in the existing Jest suite.
- Future expansion: retain the browser-level add-note → remove-note → Play → Pause smoke path as release verification, because DOM state tests alone cannot prove real browser bundles mount.

### 5.2 Cross-platform build ergonomics — in progress

- Added `verify`: one Node/npm entrypoint that runs the full Jest suite and rebuilds every browser target without mutating deploy-root copies.
- Added `serve`: a Node/Express local preview of the repository root, matching the GitHub Pages layout without requiring Python or a Bash helper.
- Rewrote the compile section of `README.md` around the supported cross-platform workflow and made the distinction between ordinary builds and Pages deployment explicit.

### 5.3 Other future work

- Finish AudioWorklet renderer to feature parity if a worklet-native render path is desired later.
- Clean up any stale standalone minified build artifacts if they are no longer needed.
- Review project-wide difficulty/maintenance issues separately if the user wants that.

## 6. What is done for now

The regression is addressed and deployed. No new implementation is planned unless the user asks for a follow-up above.
