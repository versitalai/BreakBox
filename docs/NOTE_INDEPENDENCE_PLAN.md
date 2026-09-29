# Note Independence — Paper Trail & Plan

Status: **design only, nothing implemented.** Written for review before any code is touched.

Goal: each note's **start, length and pitch are its own**. A note never has to
join a chord, never gets trimmed because another note overlaps it, and never
has its duration dictated by a neighbour. Notes may overlap in time freely,
in the same channel/pattern, at any pitch (including the same pitch).

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
*already* be created today — and then hit 1.4 below. (Inferred from code;
verify in-browser before fixing.)

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
  `false`). Per-channel (not per-song) lets a user convert one channel at a
  time and keeps drum/mod channels untouched. Mod channels are implicitly
  independent already.
- Invariants in an independent channel:
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

- **New tag** (proposal: `Y`) written *before* `p` (patterns) whenever any
  channel is independent: per-channel 1-bit flags.
- **Old-build behaviour:** an unknown tag throws today (`model.ts` ~6449).
  Two options:
  1. Accept the throw — old builds show an error on independent songs
     (simple, honest, and only songs that opted in are affected). **Recommended.**
  2. Change the decoder in the *same release* to skip unknown tags
     gracefully (forward-compat for future features too). Cheap; do it anyway
     as a separate small commit so this is the last hard break.
- **Note stream:** reuse the existing negative-rest mechanism, generalised:
  - In independent channels, sort by the stable order, and for any note with
    `start < curPart` write the direction-bit + `writePartDuration(curPart -
    start)` rest exactly as mod channels do today. The `isModChannel` gate
    becomes `isModChannel || channel.independentNotes`.
  - Terminator: keep `+isModChannel` semantic, make it
    `+(isModChannel || independent)` so decoder and encoder agree.
  - `curPart` after each note = `max(curPart, note.end)`? **No** — must match
    the decoder exactly. Rule: `curPart = note.end` (same as mod today),
    negative rests re-anchor the next start. Round-trip test enforces this.
- **Chord vs. independent:** unchanged bit layout; a note is a chord iff
  `pitches.length > 1`. Independent channels simply *prefer* single-pitch
  notes (see 2.6).
- **JSON export/import:** add `independentNotes` per channel; absent → false.
- **Integrity check:** on load, if a non-independent channel is found with
  overlapping notes (legacy corruption), keep today's behaviour — do not
  auto-convert.

### 2.3 Editing: one collision policy

Replace every direct `ChangeNoteTruncate` call with
`ChangeNoteTruncate(..., policy)` where policy is derived from
`collisionPolicy()`:

- `trim-all`: identical to today.
- `same-pitch`: identical to today's mod behaviour.
- `none`: constructor returns immediately (no-op) — except one **optional**
  behaviour for a same-pitch, same-start exact duplicate (see open Q2).
- **Fix the latent bug** (1.3): `skipNote` and `targetNoteId` must not
  conflict; target wins, skip only applies when no target is set. Add a test
  for drag/resize trimming in `trim-all` channels **before** any other
  change, as a standalone commit.

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

- Independent channels use **pitch-aware hit-testing** (same code path as mod
  channels): a note is hit if cursor time is in `[start,end]` **and** cursor
  pitch is within the note's pitch (± half a row). Clicking a different pitch
  under an existing note starts a **new independent note**.
- **Overlap at same pitch and time:** pick topmost by `layer`, then by
  `noteId` (latest wins); a small modifier (Alt+click) cycles through
  stacked notes.
- **Chord building becomes explicit:** a modifier (proposal **Shift+click** on a
  note = add pitch to that note, i.e. `ChangePitchAdded`; plain click on
  another pitch = new note). Show it in the cursor hint text. Keybind is
  remappable once the keybind-settings backlog item lands.
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

1. In `determineCurrentActiveTones`, if `channel.independentNotes`, collect
   **all active notes** for the tick (`start <= now < end`) using a
   scan bounded by a per-pattern cursor advanced monotonically (notes are
   sorted by start; keep a small "active set" so cost is O(active), not
   O(pattern)).
2. Expand active notes → a flat list of *voices* `(noteId, pitchIndex)`.
3. Tone identity: match each voice to an existing tone by
   `(noteId, pitchIndex)` instead of positional slot. Unmatched tones release;
   new voices allocate. This prevents the "chord voice 0 stole voice 1's tone"
   glitch when a note ends mid-overlap.
4. **Slides & seamless continuation**: today decided by "prevNote.end ==
   note.start". In independent channels the decision is per **lane**: a
   lane = a voice whose end equals another voice's start *and* they are the
   same instrument path. Rule: continue/slide only when a specific
   predecessor note (same channel, `end == start`, pitch-adjacent as
   configured by the slide/legato setting, and no other note started in
   between on the same pitch lane) exists. Define this once in a helper
   `findPredecessor(noteId)`; do not walk array neighbours.
5. Polyphony limits: `maxChordSize` currently caps voices per note; independent
   channels need a **channel-level voice cap** (proposal: keep a soft cap of
   e.g. 8–16 with oldest-voice steal, exposed as a constant) so a dense
   overlapping pattern can't blow up CPU. Steal policy: release
   oldest-started, prefer a voice already in its release phase.
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

- New channel menu / right-click item: **"Independent notes: on/off"**.
- Turning **on**: no data change (existing notes are valid). Bumps the
  channel flag; format tag written on next save.
- Turning **off** when overlaps exist: show a confirm dialog listing the
  number of overlaps, offering (a) *merge into chords where start/end match
  and truncate the rest*, or (b) cancel. Never silent data loss.
- New default for new songs: **off** in the first release (opt-in), revisit
  once tested.

---

## Part 3 — Phased rollout

Each phase is independently shippable, keeps the app working, and ends with
"build (`node scripts/build.cjs --deploy`) → commit → push to `revamp`".

**Phase 0 — Safety net (no user-visible change)**
- Fix `ChangeNoteTruncate` target/skip conflict; regression test.
- Add a unit test harness for note-stream round-trip (encode → decode →
  compare) covering every current channel type; commit fixtures.
- Make the decoder skip unknown tags (forward-compat).

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

## Part 6 — Open questions for you

1. Independence **per channel** (recommended) vs. **whole-song** switch?
2. Same pitch **and** same start exact duplicate: allow (stacked), or
   auto-replace? (Recommended: allow; the user can delete.)
3. Chord-build modifier: **Shift+click** on a note OK, or something else?
4. Default for **new songs**: off (recommended for first release) or on?
5. Voice cap per channel: is ~16 acceptable, or do you want unlimited with a
   CPU warning?
6. Should turning independence **off** attempt automatic chord-merging, or
   just refuse while overlaps exist?
