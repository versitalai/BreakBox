# Note Independence — Paper Trail & Plan

Status: design approved (see Decisions). **Phase 0 implemented**; Phases 1-5 not started.

Goal: each note's **start, length and pitch are its own**. A note never has to
join a chord, never gets trimmed because another note overlaps it, and never
has its duration dictated by a neighbour. Notes may overlap in time freely,
in the same channel/pattern, at any pitch (including the same pitch).

---

## Decisions (from review)

1. Independence is **per channel**.
2. Exact duplicates (same pitch, same start) are **allowed**.
3. Chord building is a **right-click toggle** (per channel, in the channel/note
   menu) instead of a fixed modifier key. When on, clicking a pitch on an
   existing note adds it to that note (today's behaviour); when off, it
   starts a new independent note. A held-key shortcut can be added later.
4. New songs default to **off**.
5. Voice cap is **user-customizable**: default **32**, with an **unlimited**
   option.
6. **The flag never rewrites notes.** Turning independence off changes only
   editing behaviour (collision trimming, hit-testing). Overlapping notes
   that exist keep saving, loading and playing. Playback resolves
   slides/continuations for overlapping notes by the **closest aligned
   note** (see 2.5).

**Consequence of #6 (design change from the first draft):** overlap support
in the *format* and *playback* can no longer hang off the flag. Instead it
hangs off **whether the channel contains overlap** (or has the flag set). The
flag only selects the editing collision policy. Songs with no overlap and
flag off remain byte-identical and use the untouched legacy playback path.

**Correction to the first draft:** "make the decoder skip unknown tags" is not
possible — song tags have no length prefix, so an old decoder cannot know how
many bits to skip. Old builds will throw on songs that use the new tag. That
is acceptable because the tag is only written when a channel actually has
overlap or independence enabled.

---

## Part 1 — Paper trail: how a note lives today

Following one note from the click that creates it to the sound it makes.

### 1.1 Data model (`synth/model.ts` ~25-160)

- `Pattern.notes: Note[]` — flat array, **assumed sorted by `start`** and
  (in non-mod channels) **non-overlapping**.
- `Note` = `pitches[]` (a *chord*, up to `maxChordSize`), `pins[]` (volume +
  pitch-bend envelope, times relative to `start`), `start`, `end`,
  `continuesLastPattern`, `noteId`, `layer`.
- The only way to have two simultaneous pitches today is to put them in the
  **same `Note.pitches[]`**. They then share start, end, pins and volume
  envelope. That is the coupling we want to remove: *chord = one note object*.
- `noteId` / `layer` were added later (routing / layer picker). They give notes
  an identity but nothing in the sorted-array/codec/DSP logic uses it yet.

### 1.2 Placement (`editor/widgets/PatternEditor.ts`)

- `_updateCursorStatus` (312-580) decides what the mouse is over. In **non-mod
  channels hit-testing is time-based**: if the cursor x is inside any note's
  `[start, end]`, that note is the hit target regardless of y. So you cannot
  place a second pitch under an existing note by clicking — you get that note.
  Only mod channels test pitch as well.
- Click on empty space → creates a 1-part-long note in `_cursor.curNote`
  preview; mouse-up (2107-2395) commits it via
  `ChangeNoteAdded` + `ChangeNoteTruncate(start, end, skipNote = newNote)`.
- **`ChangeNoteTruncate` is the collision handler.** For non-mod channels it
  deletes/shortens/splits *every other note overlapping the new range,
  whatever its pitch*. For mod channels it is predicate-based and only touches
  same-pitch overlaps. This single function is why independent notes cannot
  exist in normal channels.
- Adding a pitch to an existing note = `ChangePitchAdded` (chord building) —
  triggered when you click a different pitch *on* an existing note's time span
  in some paths.

### 1.3 Editing operations (`editor/core/changes.ts`)

| Operation | Class | Independence hazard |
|---|---|---|
| Create | `ChangeNoteAdded` (4744) | inserts at a given index — assumes caller found the right sorted index |
| Resize | `ChangeNoteLength` (4772) → then `ChangeNoteTruncate` | truncation eats neighbours |
| Drag/move | `ChangeDragSelectedNotes` (5100) | re-inserts + truncates target range |
| Transpose | `ChangeTransposeNote` (4896), `ChangeTranspose` (5036) | fine — pitch only |
| Pitch bend / pins | `ChangePinTime` (4030), `ChangePitchBend` (4062) | pitch-bend clamps against **same note's** pitches only, ok |
| Split at selection | `ChangeSplitNotesAtSelection` (4865) | index math assumes sorted |
| Paste | `ChangePaste` (3645) | truncates target range, then inserts sorted |
| Rhythm/quantize | `ChangePatternRhythm` (4136) | rebuilds from sorted order |
| Move sideways / overflow | `ChangeMoveNotesSideways` (4185), `ChangeMoveAndOverflowNotes` (404) | `projectNoteIntoBar` (~150-225) assumes ordered, non-overlapping |
| Beats-per-bar | `ChangeBeatsPerBar` (4255) | same projection path |
| Selection ops | `editor/core/Selection.ts` (232, 304-320, 403, 474-581) | copy/erase/paste iterate sorted arrays |
| Layer picker | `PatternEditor.ts` 1899-1918 | layers are a *workaround* for overlap: truncate splits produce `layer+1` |

**Latent bug found in the trail.** `ChangeNoteTruncate(..., skipNote, force,
targetNoteId)` with `targetNoteId == skipNote.noteId` skips the only note it is
allowed to touch, so it is a **no-op**. Drag/resize paths that pass both no
longer trim neighbours, meaning overlapping notes in non-mod channels can
*already* be created today — and then hit 1.4 below. (Fixed in Phase 0.)

### 1.4 Serialization — the hard wall (`synth/model.ts` `toBase64String`/`fromBase64String`)

Song state is a bit-packed base64 URL hash. Note stream per pattern
(encoder ~3958-4095, decoder ~6170-6387):

- A single running cursor `curPart` walks left→right. For each note:
  optional **rest** (gap) → `[pitch-count/bend flags]` → pitches (delta-coded)
  → pins → `curPart = note.end`.
- The stream is therefore a **sequential, non-overlapping timeline**. A note
  that starts before `curPart` cannot be represented in non-mod channels.
- **Mod channels** got an escape: a *direction bit* + `writePartDuration`
  so a rest can go **negative** (`note.start < curPart && isModChannel`). That
  is how overlapping mod notes round-trip.
- The pattern terminator is `beatsPerBar*partsPerBeat + (+isModChannel)`.
- Consequence today: overlapping non-mod notes are **silently corrupted on
  save/reload/share** (later notes shift or vanish). JSON export has no such
  problem (it serializes the array as-is) but import back into the base64 path
  does.
- Unknown `SongTagCode`s **throw** in old builds (`model.ts` ~6449). Free
  tag chars: `Y`, `Z`, digits, `-`, `_`. So a new tag hard-fails old builds —
  we must choose deliberately (see 2.2).

### 1.5 Playback (`synth/dsp.ts`)

- `determineCurrentActiveTones` (4135-4491) is the note → tone allocator.
  - **Mod branch**: already handles simultaneous notes (per-pitch-slot arrays).
  - **Non-mod branch**: one `note`, one `prevNote`, one `nextNote` per
    channel per tick, found by walking the sorted array. It allocates tones by
    *positional slot* (chord voice #0,1,2…) and uses **adjacency** for
    slides (`prevNote` end == this start) and seamless/continue-tone logic.
  - So DSP assumes at most one *active note object* at a time, with polyphony
    supplied only by `pitches[]`.
- `_routeTone` (4516) / Voice / NoteRouter / InstrumentExtension are
  downstream of tone allocation and don't care how the tone was born —
  **unaffected**.
- Mod-only note consumers (2282, 2629, 2688, 2748) are already multi-note.

### 1.6 Other producers/consumers of notes

- **Recording** — `SongPerformance.ts` (150-340): builds notes in real time,
  extends held-note ends, and appends in time order; assumes it can write to
  the end of the array.
- **MIDI import** — `ImportPrompt.ts` (~520, 590-800): quantizes then *merges
  simultaneous notes into chords* and truncates overlaps to fit.
- **MIDI export** — `ExportPrompt.ts` (~870-1000): walks the sorted array,
  emits per-pitch note on/off; fine as long as it doesn't assume a single
  active note.
- **Euclidgen** — `EuclidgenRhythmPrompt.ts` (~567, 709, 854): creates notes
  and relies on `ChangeNoteTruncate`/sorted insertion.

### 1.7 Summary of why notes aren't independent

1. Codec can't encode overlaps outside mod channels.
2. Truncation removes overlaps by design.
3. Hit-testing ignores pitch, so you can't even target a second pitch.
4. DSP allocates a single active note object per channel.
5. Many algorithms assume sorted-by-start + non-overlapping.

All five must change together, or independence will "work" in the editor and
then break on save, playback, or export.

---

## Part 2 — Scheme

### 2.0 Principles

- **Opt-in and reversible.** Old songs are byte-identical and behave
  identically. Independence is a *capability* a song turns on.
- **Chords stay.** `pitches[]` remains valid ("linked notes" — a deliberate
  grouped note). Independence means chords are *optional*, not removed.
- **One collision policy, in one place.** No call site decides on its own
  whether to trim.
- **Identity over adjacency.** DSP and edit logic key off `noteId`, not "the
  previous element in the array".

### 2.1 Model

- Add a per-**channel** flag `Channel.independentNotes: boolean` (default
  `false`). It controls **editing policy only** (decision 6). Mod channels
  are implicitly independent already.
- Add a derived, non-serialized `channel.hasOverlap` (recomputed on load and
  after any note edit, cheap scan of sorted starts vs. running max end). It
  selects the overlap-capable **codec** and **playback** paths.
  `usesOverlapPath = isMod || independentNotes || hasOverlap`.
- Chord-building toggle `Channel.chordBuilding: boolean` (default `true`,
  saved with the flag).
- Invariants when `usesOverlapPath` is true:
  - `pattern.notes` is sorted by `(start, pitches[0], noteId)` — a *stable
    total order* — but **overlap is allowed**, including identical pitch.
  - `noteId` unique within the pattern (already assigned by `assignNoteId`).
  - `layer` becomes purely cosmetic/lane hint; no longer produced by split.
- Add a single helper module `synth/noteCollision.ts` (name TBD) exposing:
  - `collisionPolicy(doc, channel): "trim-all" | "same-pitch" | "none"`
    (`trim-all` = today's non-mod; `same-pitch` = today's mod;
    `none` = independent).
  - `sortNotes(pattern)` and `insertIndexFor(pattern, note)` implementing the
    stable order so every caller uses one definition.
  - `overlapsWithSamePitch(...)` predicate.

### 2.2 File format (URL + JSON)

- **New tag** (proposal: `Y`) written *before* `p` (patterns) **only when at
  least one non-mod channel has `independentNotes` or `hasOverlap`**. Per
  pitch/noise channel, 3 bits: `overlapStream`, `independentNotes`,
  `chordBuilding`. Otherwise the tag is omitted and the hash is unchanged.
- **Old-build behaviour:** an unknown tag throws today (`model.ts` ~6449) and
  cannot be skipped (no length prefix). Accepted: only songs that use the
  feature are affected.
- **Note stream:** reuse the existing negative-rest mechanism, generalised:
  - In overlap-path channels, sort by the stable order, and for any note with
    `start < curPart` write the direction-bit + `writePartDuration(curPart -
    start)` rest exactly as mod channels do today. The `isModChannel` gate
    becomes `isModChannel || overlapStream` (the per-channel bit from the `Y`
    tag, which the decoder reads before the pattern data).
  - Terminator: keep `+isModChannel` semantic, make it
    `+(isModChannel || overlapStream)` so decoder and encoder agree.
  - `curPart` after each note = `max(curPart, note.end)`? **No** — must match
    the decoder exactly. Rule: `curPart = note.end` (same as mod today),
    negative rests re-anchor the next start. Round-trip test enforces this.
- **Chord vs. independent:** unchanged bit layout; a note is a chord iff
  `pitches.length > 1`. Independent channels simply *prefer* single-pitch
  notes (see 2.6).
- **JSON export/import:** add `independentNotes` and `chordBuilding` per
  channel; absent → defaults. Overlapping notes in JSON are kept as-is.
- **Legacy corruption:** hashes already saved with overlapping non-mod notes
  are already scrambled; nothing can recover them. Only new saves are safe.

### 2.3 Editing: one collision policy

Replace every direct `ChangeNoteTruncate` call with
`ChangeNoteTruncate(..., policy)` where policy is derived from
`collisionPolicy()`:

- `trim-all`: identical to today.
- `same-pitch`: identical to today's mod behaviour.
- `none`: constructor returns immediately (no-op). Exact duplicates are
  allowed (decision 2).
- **Latent bug (1.3): fixed in Phase 0** by dropping the conflicting
  `targetNoteId` argument at the three resize call sites in `PatternEditor`
  (`skipNote` alone is what the original code used). Covered by
  `tests/noteStream.test.ts`.

Call sites to route through the policy (audit list, each with a test):
`PatternEditor` place/resize/drag (2107-2395), `ChangeDragSelectedNotes`,
`ChangePaste`, `ChangeMoveNotesSideways`, Euclidgen (567/709/854),
`SongPerformance` recording, MIDI import, `ChangePatternRhythm`.

Insertion index: all `ChangeNoteAdded(index)` callers use
`insertIndexFor()` instead of ad-hoc "find first note with start > x" loops.
Any operation that changes `start` (drag, move sideways, rhythm, quantize)
ends with `sortNotes()` inside its own undo step (record the old order so
undo restores it — `ChangeNoteAdded` splices by index so undo of an
in-place re-sort needs a small `ChangeSortNotes` UndoableChange).

`projectNoteIntoBar` / `ChangeMoveAndOverflowNotes` / `ChangeBeatsPerBar`:
in independent channels, remove the "resolve overlap with neighbour" step;
projection just clips each note independently to the bar (and splits with
`continuesLastPattern` as today). No ordering assumption remains.

### 2.4 Hit-testing & interaction (`PatternEditor._updateCursorStatus`)

- Channels with `independentNotes` on (or chord building off) use **pitch-aware hit-testing** (same code path as mod
  channels): a note is hit if cursor time is in `[start,end]` **and** cursor
  pitch is within the note's pitch (± half a row). Clicking a different pitch
  under an existing note starts a **new independent note**.
- **Overlap at same pitch and time:** pick topmost by `layer`, then by
  `noteId` (latest wins); a small modifier (Alt+click) cycles through
  stacked notes.
- **Chord building is a toggle** (decision 3): right-click menu item
  "Chord building: on/off" per channel. On = today's behaviour (clicking a
  pitch on an existing note adds it via `ChangePitchAdded`). Off = clicking
  a different pitch starts a new independent note. Show the state in the
  cursor hint text. Default on for legacy channels; turning independence on
  for a channel suggests (but does not force) turning chord building off.
- Resize handles, pin/volume editing, and selection rectangles hit-test the
  exact note under the cursor, not "the note in this time slice".
- Rendering: overlapping notes draw at their own pitch row already (each
  `Note` draws per pitch); layering colour hint from `layer`. Add
  slight translucency only where two notes share a row & time.
- Per-note lock toggles from the right-click backlog (pitch lock, duration
  lock) slot in here later; independence is a prerequisite for them to be
  meaningful.

### 2.5 Playback (`synth/dsp.ts`)

Goal: make the non-mod branch handle **N simultaneous note objects** the way
the mod branch already does, without changing behaviour when there is ≤1
active note.

Approach (keep the old path for non-independent channels):

1. In `determineCurrentActiveTones`, if `usesOverlapPath`, collect
   **all active notes** for the tick (`start <= now < end`) using a
   scan bounded by a per-pattern cursor advanced monotonically (notes are
   sorted by start; keep a small "active set" so cost is O(active), not
   O(pattern)).
2. Expand active notes → a flat list of *voices* `(noteId, pitchIndex)`.
3. Tone identity: match each voice to an existing tone by
   `(noteId, pitchIndex)` instead of positional slot. Unmatched tones release;
   new voices allocate. This prevents the "chord voice 0 stole voice 1's tone"
   glitch when a note ends mid-overlap.
4. **Slides & seamless continuation ("closest aligned note", decision 6)**:
   today decided by `prevNote.end == note.start`. On the overlap path, a
   note's predecessor is chosen by `findPredecessor(note)`: among notes in
   the same pattern (or the previous pattern's tail for
   `continuesLastPattern`) whose `end <= note.start` (or that are still
   sounding when `note` starts, for overlaps), pick the one with the
   smallest `|note.start - candidate.end|`; ties broken by smallest pitch
   distance, then by lowest `noteId`. Slide/seamless continuation applies
   only if that gap is 0 (touching) or, for a still-sounding overlap, the
   two share a pitch lane; otherwise the note gets a fresh tone. The same
   helper picks the successor (`findSuccessor`) for release/fade logic.
   Never walk array neighbours. Legacy (non-overlap) channels keep the
   old adjacency code untouched.
5. Polyphony limits: `maxChordSize` currently caps voices per note; the
   overlap path needs a **channel-level voice cap** — user setting
   `voiceCap` (default **32**, or **unlimited**), stored in user
   preferences (not the song) so a shared song can't force a CPU spike.
   Steal policy when the cap is hit: release oldest-started, prefer a voice
   already in its release phase. Show a small "voices stolen" indicator
   when it happens.
6. Pitch-bend/pins: each note evaluates its own pins by
   `ticksIntoNote` — already per-note; just ensure the evaluation is per
   voice, not "the" note.
7. Instrument-extension routing (`_routeTone`) sees ordinary tones — no
   change.

Risk areas: seamless-tone logic (`_isSeamless`-style flags),
`noteStartInstruments`/envelope restarts per voice, and the visualiser hooks
that read "the" current note. Each gets an explicit test (section 4).

### 2.6 Producers

- **Recording (`SongPerformance`)**: in independent channels, each held key
  is its own note; key-up sets that note's `end`. No truncation, no chord
  merge. Notes are appended, then a final `sortNotes` on stop (inside the
  recording's undo step).
- **MIDI import (`ImportPrompt`)**: independent target → **do not merge
  simultaneous notes into chords and do not truncate overlaps**; one MIDI note
  = one Note. Non-independent target → unchanged. Add an import checkbox
  "Keep notes independent" (defaults on when channel is independent).
- **MIDI export (`ExportPrompt`)**: emit note-on/off from `(start, end,
  pitch)` per note; no assumption of exclusivity. Optional: split
  overlapping same-pitch notes across MIDI channels only if a downstream
  synth would choke (usually unnecessary; same-pitch overlap uses
  note-off pairing by order — pair each on with the earliest matching off
  to preserve length).
- **Euclidgen**: generate notes independently; skip the truncate step in
  independent channels. Layer/collision option becomes "Overlap allowed".
- **Selection copy/paste (`Selection.ts`)**: clipboard keeps `(start, pitch,
  length, pins)` per note; paste inserts with `insertIndexFor` and no
  truncation in independent channels. Erase-in-range is by note identity
  (delete all notes whose span intersects the range, per current UI
  semantics).
- **Layer picker**: repurposed as a visual/edit-focus lane filter, not a
  collision workaround.

### 2.7 Migration / conversion UX

- New channel menu / right-click items: **"Independent notes: on/off"** and
  **"Chord building: on/off"** (decision 3).
- Neither toggle ever modifies, merges, or deletes notes (decision 6).
  Turning independence off just restores the trimming collision policy for
  *future* edits; existing overlaps stay, save, load and play. Editing an
  overlapping note in a non-independent channel trims only what that edit
  touches, as today.
- New default for new songs: **off** (decision 4).

---

## Part 3 — Phased rollout

Each phase is independently shippable, keeps the app working, and ends with
"build (`node scripts/build.cjs --deploy`) → commit → push to `revamp`".

**Phase 0 — Safety net (no user-visible change)**
- Fix `ChangeNoteTruncate` target/skip conflict; regression test. **(done)**
- Add a unit test harness for note-stream round-trip (encode → decode →
  compare); `tests/noteStream.test.ts`. **(done — pitch and mod channels;
  noise channel and pin/bend fixtures to be added in Phase 1)**
- ~~Make the decoder skip unknown tags~~ — not possible (see Decisions).

**Phase 1 — Format**
- Channel flag, `Y` tag, generalised negative rests, JSON field.
- Round-trip tests with overlapping same-pitch and different-pitch notes,
  notes crossing pattern boundaries, and 0-length rests.
- No UI yet: enable via a hidden debug hook to test.

**Phase 2 — Playback**
- Multi-note branch in `determineCurrentActiveTones` gated by the flag.
- Tone identity matching, per-lane predecessor logic, voice cap.
- Golden-audio comparison for non-independent channels (must be bit-identical
  to before) plus targeted overlap scenarios.

**Phase 3 — Editing**
- Collision policy module; route all call sites; pitch-aware hit-testing;
  chord-modifier; sorting/`ChangeSortNotes`; bar-projection changes.

**Phase 4 — Producers & tools**
- Recording, MIDI import/export, Euclidgen, selection copy/paste/erase, layer
  picker repurpose.

**Phase 5 — UI & migration**
- Channel toggle, conversion dialog, hints/tooltips, docs.
- Hooks for right-click note menu (pitch/duration locks) once that backlog
  item is started.

---

## Part 4 — Test plan

Automated (Phase 0 harness):
1. **Codec round-trip**: random sets of overlapping notes → encode →
   decode → deep-equal (`start`, `end`, `pitches`, `pins`, `continuesLastPattern`).
   Also: old fixtures (pre-change URL hashes) decode identically.
2. **Old build compatibility**: songs with no independent channel produce the
   exact same hash as before (byte-identical regression).
3. **Truncate policy**: each of `trim-all`, `same-pitch`, `none` across the
   cases (contained, straddling start, straddling end, exact overlap).
4. **Sort invariants** after every editing change (drag, paste, rhythm, bar
   resize).
5. **Undo/redo** for every changed operation restores order and content.

Manual (browser):
- Place overlapping notes at different lengths and pitches; scrub; reload
  from URL; share URL; export JSON and re-import; export MIDI and open in
  another DAW.
- Play overlapping same-pitch notes with slide/legato instruments; verify no
  stuck or missing notes.
- Bar-length change and paste across pattern boundary with overlapping notes.
- Mod channels and drum channels unaffected.
- CPU with dense overlap (cap works, no glitching).

---

## Part 5 — Risks

| Risk | Mitigation |
|---|---|
| Silent hash break for existing songs | byte-identical regression test; flag off by default |
| Old builds error on independent songs | documented; skip-unknown-tags forward-compat commit |
| DSP regressions in non-independent channels | separate gated branch; golden-audio compare |
| Voice explosion / CPU | channel voice cap + steal policy |
| Ambiguous hit target with stacked notes | layer/noteId ordering + Alt-cycle; visible highlight |
| Undo of re-sort | explicit `ChangeSortNotes` records prior order |
| Scope creep into right-click features | independence lands first; locks/keyframes are follow-ups |

## Part 6 — Remaining open questions

1. Chord-building toggle lives in the channel right-click menu. Should it
   also get a keyboard shortcut once keybind settings exist? (Deferred.)
2. Voice-cap setting: which settings panel should host it? (Proposed:
   Preferences, next to the other audio options.)
