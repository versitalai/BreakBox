# BreakBox Architecture

BreakBox is a fork of JukeBox_TypeScript (a BeepBox-derived chiptune / breakcore music
tool). Everything runs client-side, offline-first: a song is a URL hash (base64-encoded
JSON), the editor renders a piano-roll UI, and synthesis happens either on the main
thread (legacy `Synth`) or on an `AudioWorklet` thread (new, under construction).

> **Repo state (Aug 2026):** a reorg is in flight. `synth/synth.ts` (~16k lines) is
> being split into modules (logically `synth/model/*`) and `editor/*` is being moved
> into `editor/core|model|widgets|prompts|audio/`. The public export surface is
> unchanged. This doc describes the **logical** layers; paths below reflect the
> current flat layout unless noted. Line numbers are accurate as of this writing but
> will drift — grep for symbols rather than trusting them.

---

## 1. Layer diagram

```
┌────────────────────────────────────────────────────────────────┐
│ global/            Events (event bus), Oscilloscope            │
│        ▲                            ▲                          │
│        │ imported by                │ imported by              │
│        │                            │                          │
│ synth/  ◄── AUDIO ENGINE ──►  (model + DSP)                    │
│   │                                                           │
│   ├─ legacy path (single-threaded, main thread)               │
│   │    Synth ──ScriptProcessorNode──► AudioContext            │
│   │        ▲                                                  │
│   │        │ wrapped by                                       │
│   │   editor/LegacySynthAdapter.ts (implements AudioEngineApi)│
│   │                                                           │
│   └─ NEW AudioWorklet path (splits off here)                  │
│        AudioEngineApi.ts  (interface, shared)                 │
│        BreakBoxAudioEngine.ts  (main thread: scheduler)       │
│              │ postMessage({type,payload}, transferables)     │
│              ▼                                                │
│        BreakBoxProcessor.ts  (AudioWorklet thread, render)    │
│              │ AudioWorkletNode ──► AudioContext.destination  │
│        ▲                                                     │
│   editor/WorkletSynthAdapter.ts (feature-detect, fallback)    │
│                                                               │
│ editor/  ◄── UI ──►  SongEditor → prompts/widgets             │
│   main.ts entry; SongDocument (state+undo); changes.ts        │
│                                                               │
│ player/  ◄── embed player (own main.ts, own bundle)           │
└────────────────────────────────────────────────────────────────┘
        ▲
   website/  build output (bundles + assets), served statically
```

The editor never talks to the worklet directly — it goes through the
`AudioEngineApi` interface. `WorkletSynthAdapter` picks worklet when available,
else `LegacySynthAdapter`.

---

## 2. Source folder map

| Folder | Contents |
|---|---|
| `synth/` | **Engine + model.** `synth.ts` (monolith: Note→Song model, serialization, Synth DSP loop — being split), `SynthConfig.ts` (Config constants, enums, option tables, sample loading), `filtering.ts` (DynamicBiquadFilter, FilterCoefficients), `FFT.ts` (fourier helpers), `Deque.ts` (ring buffer), `PresetUpdates.ts` (version migration). New worklet: `AudioEngineApi.ts`, `BreakBoxAudioEngine.ts`, `BreakBoxProcessor.ts`, `audio-worklet.d.ts` |
| `editor/` | **UI.** `main.ts` (entry), `SongEditor.ts` (layout + prompt manager), `SongDocument.ts` (state + undo), `Change.ts` + `changes.ts` (undoable edits), `*Prompt.ts` (modal dialogs), editor widgets (PatternEditor, TrackEditor, LoopEditor, EnvelopeEditor, FilterEditor, HarmonicsEditor, SpectrumEditor, FadeInOutEditor, MuteEditor, Piano, scrollbars, Selection, KeyboardLayout, Layout, Preferences, ColorConfig, style.ts), audio glue (`LegacySynthAdapter.ts`, `WorkletSynthAdapter.ts` — logically `editor/audio/`), IO (`ArrayBufferReader/Writer`, `Midi.ts`, `MidiInput.ts`, `SongRecovery.ts`) |
| `player/` | **Embed player.** `main.ts` (own entry, compiled separately), `index.html`, prebuilt bundles + sample packs (samples.js, samples2.js, samples3.js, drumsamples.js, wario_samples.js, ...) |
| `global/` | Cross-cutting. `Events.ts` (event bus singleton), `Oscilloscope.ts` |
| `scripts/` | Build scripts (see §6) + `build/` (tsc emit dir, gitignored) |
| `website/` | **Deploy output.** Bundled JS (editor/synth/player + processor), theme_resources/, sample packs, manifests |
| root | sample packs (samples*.js, wario_samples.js), `theme_resources/`, `offline/`, `manual/`, `synth_example.html`, `snake.html`, `site.webmanifest`, tsconfigs, package.json |

---

## 3. Audio data flow

### 3a. Song state & serialization (shared by both paths)

```
Note (pitches+pins) ──► Pattern (notes + instrument refs) ──► Channel (instruments)
      ──► Song (tempo, scales, channels, loops) ──toBase64String()──► URL hash (#...)
      ◄── new Song(hash) parses (versioned, variant 'J' JukeBox) ──
```

- `Song` (`synth/synth.ts:3303`) is the single source of truth; `toBase64String()`
  at `synth.ts:3647`. Every edit serializes back into the hash (undo = history states).
- Model classes (`Note` 425, `Pattern` 491, `Instrument` 1625, `Channel` 3294, `Song`)
  carry their own `toJsonObject`/`fromJsonObject` and mutate in place.

### 3b. Legacy path (main thread)

```
SongDocument.synth = new Synth(song)          // SongDocument.ts:96
Synth.play() (synth.ts:10490) → createScriptProcessor(...) (synth.ts:10465)
  → audioProcessCallback → synthesize(L,R) (synth.ts:10889)
    → per channel: Tone (8516) ← InstrumentState (8639) ← EnvelopeComputer (7891)
    → per instrument type: synth fn from getInstrumentSynthFunction (13180)
      (chip → loopableChipSynth 13319; FM; noise; spectrum; granular; picked string…)
    → master FX (compressor/limiter) → AudioContext output
```

Single-threaded: UI jank under heavy patterns is the problem the worklet path solves.

### 3c. NEW AudioWorklet path

```
SongDocument.audioEngine = new WorkletSynthAdapter()   // SongDocument.ts:101
  → supportsAudioWorklet() ? BreakBoxAudioEngine : LegacySynthAdapter   (WorkletSynthAdapter.ts:18)
BreakBoxAudioEngine.init() (BreakBoxAudioEngine.ts:18)
  → new AudioContext + audioWorklet.addModule('/breakbox-processor.js')
  → AudioWorkletNode 'breakbox-processor' (2 out) → destination
setSong() → serializeSongForWorklet() (minimal subset: tempo, bars, channels/instruments)
  → postMessage {type:'init'}
play() → startScheduler() (BreakBoxAudioEngine.ts:145)
  → ~200Hz setTimeout loop, pushes commands ~30ms (lookaheadMs) ahead
  → postMessage {type:'note_on'|'note_off'|'update_fx', payload}
BreakBoxProcessor.handleCommand() (BreakBoxProcessor.ts:106)
  → commandQueue (tick-sorted) → process() render loop (BreakBoxProcessor.ts:380)
    → per 128-frame quantum: processScheduledCommands → renderVoice() per VoiceState
    → soft limiter → playhead postMessage
  → engine.handleWorkletMessage() → onTick → SongDocument syncs legacy synth.playhead for UI
```

Sample transfer: `loadSample(key, ArrayBuffer)` posts with **transferables** (zero-copy)
into `samplePool: Map<string, Float32Array>` in the processor (`BreakBoxProcessor.ts:81`).

---

## 4. Class map — `synth/synth.ts` (or split `synth/model/*`)

**Model / serialization**
- `Note` (425) — pitches, pins (glide), start/end; one row of the piano roll.
- `Pattern` (491) — ordered notes + per-pattern instrument indices.
- `Operator` (706) — FM operator (frequency/mult/feedback); `CustomAlgorithm` (731), `CustomFeedBack` (791).
- `SpectrumWave` (836) / `HarmonicsWave` (915) — FFT-drawn / harmonic-additive wave shapes (+`State` caches).
- `Grain` (1003) — granular delay-line grains; `PickedString` (7669) — karplus-strong delay strings.
- `FilterControlPoint` (1075) / `FilterSettings` (1149) — EQ/note filter curves.
- `EnvelopeSettings` (1410) — one automatable envelope.
- `Instrument` (1625) — ALL voice parameters (type, waves, filters, envelopes, pitchShift, detune, vibrato, unison, sample fields…) + serialization. **Primary extension point.**
- `Channel` (3294) — octave + instrument list.
- `Song` (3303) — top-level state, versioned (de)serialization, patterns, loops, mod channels.

**DSP (all `class` non-exported, main-thread render)**
- `EnvelopeComputer` (7891) — computes envelope target/time per note from EnvelopeSettings.
- `Tone` (8516) — per-note per-channel render state (phases, phaseDeltas, filters, expressions); pooled.
- `InstrumentState` (8639) — per-instrument continuous state (envelopes, waves, vibrato, buffers).
- `ChannelState` (9756) — instruments[] per channel.
- `Synth` (9762) — the engine: `play/pause/goToBar` (10490/10499/10657), `synthesize` (10889), `computeTone` (12149), `getInstrumentSynthFunction` (13180), `loopableChipSynth` (13319), `getSamplesPerTick` (15902). Depends on `Tone/InstrumentState/EnvelopeComputer`, `filtering.ts`, `FFT.ts`.

**Config (`synth/SynthConfig.ts`)**
- `Config` (877) — constants + option tables (`jsonFormat` 887, scales, keys, waves, `maxEnvelopeCount`…).
- Enums: `FilterType` (33), `EnvelopeType` (53), **`InstrumentType` (73)**, `EffectType` (103), `EnvelopeComputeIndex` (126), etc.; `TypePresets` (89).
- Sample loading: `SampleLoadingState`/`sampleLoadingState` (328/342), `SampleLoadEvents`/`sampleLoadEvents` (359/365), `loadBuiltInSamples` (550).

**New worklet path**
- `AudioEngineApi` (interface, `AudioEngineApi.ts:1`) — lifecycle + `loadSample` + `onTick`. `NoteVoice` (:17) carries `sampleKey/transpose/reverse/probability/rollCount`; `VoiceFx` (:29); `VoiceCommand` (:37).
- `BreakBoxAudioEngine` (`BreakBoxAudioEngine.ts:7`) — main-thread impl: AudioContext/worklet wiring, 30ms lookahead scheduler, command queue, sample transfer, master volume. Public scheduling API: `scheduleNoteOn/scheduleNoteOff/scheduleFxUpdate` (:203).
- `BreakBoxProcessor` (`BreakBoxProcessor.ts:73`) — `AudioWorkletProcessor` scaffold; command switch (:106), voice pool (128 w/ stealing), `samplePool`, `renderVoice` stub (:314), `process()` loop (:380), `registerProcessor('breakbox-processor')` (:425). **Real DSP not yet ported.**

---

## 5. Editor architecture

- **`SongDocument`** (`editor/SongDocument.ts:29`) — owns `song`, `synth` (legacy, kept for UI queries/playhead), `audioEngine` (new), `selection`, `prefs`, `notifier`, history (`_maximumUndoHistory` = 300, persisted via sessionStorage + URL hash + `popstate`), `SongRecovery` autosave. Constructor parses hash → `new Song()`, wires `WorkletSynthAdapter`, hooks `change/click/keyup/...` window events → `_cleanDocument` (deferred render).
- **`Change` / `changes.ts`** — `Change.ts` defines `Change` (noop-tracking), `UndoableChange` (`_doForwards/_doBackwards`), `ChangeGroup`, `ChangeSequence`. `changes.ts` (~5.7k lines) holds every concrete edit: `ChangeSong`, `ChangePreset`, `ChangeInstrument`, … plus helpers (`setDefaultInstruments`, `discardInvalidPatternInstruments`). Widgets construct a Change from slider values; `SongDocument` pushes it, applies it, re-serializes the hash.
- **`SongEditor`** (`editor/SongEditor.ts:724`) — the whole UI: `doc: SongDocument`, a `prompt: Prompt | null` slot, and dozens of widget editors (PatternEditor, TrackEditor, LoopEditor, EnvelopeEditor, FilterEditor, HarmonicsEditor, SpectrumEditor, MuteEditor, Piano, scrollbars…). Widgets are built from `HTMLWrapper` helpers (`div/input/button`, `Slider`, `Stepper`). **Pattern:** a prompt (`ChannelSettingsPrompt`, `AddSamplesPrompt`, `ExportPrompt`, …) is a modal implementing the `Prompt` interface; it creates Changes and calls `doc.prompt` to swap. `editor/main.ts` instantiates `SongEditor` and mounts it.

---

## 6. Build pipeline

`npm run build` → synth → player → editor → website. Each stage: **tsc → rollup → terser**.

| Script (`scripts/`) | tsc config | Rollup entry → output | Notes |
|---|---|---|---|
| `compile_beepbox_synth.sh` | `tsconfig_synth_only.json` (files: `synth/synth.ts`) **+** `tsconfig_processor.json` (`BreakBoxProcessor.ts`) | `build/synth/synth.js` → `website/beepbox_synth.js` (IIFE, global `beepbox`); processor → `website/breakbox-processor.js` (**module**, copied not bundled) | terser → `.min.js` + maps; `--define OFFLINE=false`, `--mangle-props /^_.+/`; processor minified with `--module` |
| `compile_beepbox_player.sh` | `tsconfig_player.json` (extends synth, files: `player/main.ts`) | → `website/player/beepbox_player.js` (+.min) | embed player bundle |
| `compile_beepbox_editor.sh` | `tsconfig_editor.json` (files: `editor/main.ts`) | → `website/beepbox_editor.js` (+.min) | includes synth + editor + global |
| `compile_beepbox_website.sh` | — | copies samples/theme_resources/manifests → `website/` | |
| `compile_beepbox_offline*.sh` | — | offline/Electron bundles | `npm start` runs Electron on `to_deploy` |
| `live_editor*.sh` | — | watch-mode dev servers | |

The synth bundle pulls in `editor/EditorConfig` + `global/Events` (see §7) — the
rollup of `synth/synth.js` therefore includes editor code. The processor is built
standalone so it stays import-free.

---

## 7. Cross-layer dependency warnings

- **Back-link:** `synth/synth.ts` imports `Preset, EditorConfig` from `../editor/EditorConfig`
  (line 4) and `events` from `../global/Events` (line 7). The engine depends on the
  editor — this is why `tsconfig_synth_only.json` drags editor files into the synth
  bundle, and why the legacy `Synth` can never run standalone. Don't add new
  editor/global imports to synth model classes; break these links as files split.
- **Processor purity:** `BreakBoxProcessor.ts` runs in `AudioWorkletGlobalScope` — no
  `window`/`document`/`AudioContext`. It must never import editor or DOM code, and
  only communicate via `port.postMessage`. Keep it that way; any new import there
  breaks `addModule()` at runtime.
- **No AudioBuffer in worklet:** `AudioWorkletGlobalScope` cannot `decodeAudioData`.
  The main thread must decode samples and transfer raw `Float32Array` (already the
  plan in `BreakBoxAudioEngine.loadSample` → `BreakBoxProcessor.loadSample`).
- **Two sources of truth:** `SongDocument.synth` (legacy, drives UI playhead) and
  `SongDocument.audioEngine` (playback). New playback features must be wired through
  `AudioEngineApi` and echoed onto the legacy `Synth` state for the UI.

---

## 8. Where new features plug in

### 6A — Sample Pitch Lock (disable pitch-shift/detune on custom samples)

1. **Model:** `Instrument` (`synth/synth.ts:1625`) — add `public samplePitchLock: boolean = false;` + serialization in its `toJsonObject/fromJsonObject`.
2. **DSP (legacy):** `Synth.computeTone` (`synth.ts:12149`) and `loopableChipSynth` (`synth.ts:13319`) — when flag set, ignore `pitchShift`/`detune` contributions to `intervalStart/intervalEnd` and clamp per-voice phase delta to the sample's `rootKey`.
3. **Interface:** `NoteVoice` (`synth/AudioEngineApi.ts:17`) — add `samplePitchLock: boolean`. It flows through `BreakBoxAudioEngine.scheduleNoteOn` → `note_on` payload automatically (voice object is passed whole, `BreakBoxAudioEngine.ts:203`).
4. **Worklet:** `VoiceState` (`BreakBoxProcessor.ts:29`), `triggerNoteOn` (`:272`), `renderVoice` (`:314`) — carry the flag; skip pitch-scaling in sample playback when set.
5. **UI:** checkbox in `editor/ChannelSettingsPrompt.ts` (class at `:12`); wire via a new `Change*` subclass in `editor/changes.ts` (pattern: slider → `new ChangeX(doc, …)` in SongEditor). Instrument-type dropdown data lives in `editor/EditorConfig.ts` (`presetCategories`, ~:60).

### 6B — Per-Note Custom Samples (multi-sample instrument)

1. **Enum:** `InstrumentType` (`synth/SynthConfig.ts:73`) — add `multiSample`; add to `TypePresets` (`:89`).
2. **Model:** `Instrument` (`synth/synth.ts:1625`) — `sampleMap: Map<number, SampleEntry>` (pitch → entry) + serialization as `{ pitch: sampleEntry }` dict. Reuse `SampleEntry` shape from `editor/AddSamplesPrompt.ts:10` (`url, sampleRate, rootKey, percussion`).
3. **DSP (legacy):** sample lookup in `computeTone`/`loopableChipSynth`; new branch in `getInstrumentSynthFunction` (`synth.ts:13180`) for `multiSample`; fallback to default sample when pitch missing.
4. **Interface:** `NoteVoice.sampleKey` already exists (`AudioEngineApi.ts:24`) — carry resolved sample key; may add `multiSampleRootKey` for pitch calc.
5. **Worklet:** `serializeInstrument` in `BreakBoxAudioEngine.ts:134` must include `sampleMap`; `BreakBoxProcessor.triggerNoteOn/renderVoice` resolve `sampleMap.get(pitch)` → `samplePool`.
6. **UI:** new `editor/SampleMapPrompt.ts` (virtual keyboard, drag-drop per-key assignment — planned in Phase 4); entry point + "sample map" button in `editor/ChannelSettingsPrompt.ts`; dropdown entry via `EditorConfig.presetCategories`.

---

## 9. Quick reference (grep targets)

- Legacy engine: `class Synth` (synth.ts:9762) · `synthesize` (10889) · `computeTone` (12149) · `getInstrumentSynthFunction` (13180)
- Model: `class Instrument` (1625) · `class Song` (3303) · `toBase64String` (3647) · `class Note` (425) · `class Pattern` (491)
- Config: `class Config` (SynthConfig.ts:877) · `enum InstrumentType` (73)
- AudioEngineApi: `AudioEngineApi` (:1) · `NoteVoice` (:17) · `VoiceCommand` (:37)
- Worklet: `BreakBoxAudioEngine` (:7) · `BreakBoxProcessor` (:73) · `renderVoice` (:314) · `process` (:380)
- Adapters: `WorkletSynthAdapter` (:9) · `LegacySynthAdapter` (:4)
- Editor: `SongDocument` (:29) · `SongEditor` (:724) · `Change`/`UndoableChange` (Change.ts:3/17) · `ChannelSettingsPrompt` (:12) · `SampleEntry` (AddSamplesPrompt.ts:10)
