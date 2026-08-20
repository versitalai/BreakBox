# 🛠️ BreakBox Implementation Plan

This document outlines the architectural changes and feature additions for BreakBox, specifically optimized for breakcore creation and general music production.

## 🎯 Core Objectives
1. **Multithreading**: Move audio synthesis to a separate thread to prevent UI lag during complex patterns.
2. **Per-Note Sample Mapping**: Allow different samples (or slices) for individual notes on the piano roll.
3. **Individual Note Effects**: Apply specific effects to individual note triggers rather than global instrument settings.
4. **Offline-First**: Zero server dependency; must function fully offline via PWA and IndexedDB.

---

## 📅 Phase 1: The "Multithreading" Shift (AudioWorklet)
*Goal: Isolate audio processing from the main UI thread while maintaining sample-accurate timing.*

- [ ] **AudioWorklet Integration**: Move the synthesis loop from `synth/synth.ts` into a new `BreakBoxProcessor.ts` extending `AudioWorkletProcessor`.
- [ ] **Look-Ahead Scheduler**: Implement a scheduler in the main thread that queues events 25-50ms in advance to eliminate `postMessage` jitter.
- [ ] **Command Queue System**: Instead of sending the full song state, use a delta-update system (e.g., `SET_NOTE_PITCH`) to minimize message overhead.
- [ ] **Zero-GC Processing**: Pre-allocate all TypedArrays and effect objects within the Processor to avoid Garbage Collection (GC) pauses and audio pops.
- [ ] **Sample Transfer**: Use `postMessage` with **transferable objects** (ArrayBuffers) to move sample data from the editor to the Worklet.

## 📅 Phase 2: The Slicing Engine & Sample Mapping
*Goal: Turn the synth into a true multi-sample instrument/slicer.*

- [ ] **Instrument Schema Update**: Modify `SynthConfig.ts` to replace the single `sample` buffer with a `sampleMap` (Map of Pitch $\rightarrow$ SampleData).
- [ ] **Transient Auto-Slicing**: Create a utility that analyzes a sample for peaks (transients) and automatically maps slices to the piano roll.
- [ ] **Fallback Logic**: Implement a system where the synth checks for a custom sample at the requested pitch; if missing, it defaults to the base sample with pitch-shifting.
- [ ] **Note-Level Manipulation**: Add a `Reverse` and `Transpose` toggle per note in the sequencer.

## 📅 Phase 3: Individual Note Effects & Probability
*Goal: Per-voice DSP and generative rhythmic elements.*

- [ ] **Note Metadata Expansion**: Extend the `Note` class to include:
    - `effectOverrides`: Custom bitcrush, filter cutoff, etc.
    - `probability`: 0-100% chance of triggering.
    - `rollCount`: Number of times the note repeats within its duration.
- [ ] **Per-Voice FX Chain**: In the `AudioWorkletProcessor`, instantiate a unique "Voice" object for every active note with its own lightweight FX chain.
- [ ] **Automation Linkage**: Connect per-note effects to the existing automation system.

## 📅 Phase 4: UI & UX Integration
*Goal: Make the complex mapping and generative tools intuitive.*

- [ ] **Sample Mapper Prompt**: Build a new interface (`editor/SampleMapPrompt.ts`) with a virtual keyboard for drag-and-drop sample mapping.
- [ ] **Pattern Randomizer**: Implement a "Chaos" tool to randomly shift notes, durations, or samples within a selection.
- [ ] **Visual Feedback**: Update the `PatternEditor` to visually distinguish between "Pitched Notes" and "Sampled Notes."
- [ ] **PWA & Storage**:
    - Hardened `manifest.webmanifest` and Service Worker for a native app experience.
    - **IndexedDB Integration**: Store user-uploaded samples in IndexedDB so they persist across sessions offline.

## 📅 Phase 5: General Music Optimizations
*Goal: Professional-grade workflow and audio quality.*

- [ ] **Workflow Ergonomics**:
    - **Custom Key-Bind Map**: Allow users to remap shortcuts via a JSON config.
    - **Batch Editing**: Selection-based relative shifts (pitch, timing, duration) for multiple notes.
    - **Swing/Humanize**: Add grid-offset presets to reduce "robotic" timing.
- [ ] **Audio Engineering**:
    - **Master Limiter/Compressor**: Add a soft-knee limiter to the master output to prevent digital clipping.
    - **Visual Waveform Editor**: Real-time waveform display for the active sample/slice.
    - **Spectrum Analyzer**: FFT-based visualizer for frequency monitoring.
- [ ] **Project Management**:
    - **Snapshot System**: Non-destructive "versioning" of the song state.
    - **Advanced Compression**: Implement LZW or binary-to-base64 compression for shorter, shareable URLs.
    - **Local Sample Library**: A side-panel browser for IndexedDB-saved samples.

---

## 📅 Phase 6: Breakcore-Specific Enhancements (from user ideas)

*Goal: Two breakcore-focused features that unlock more creative control.*

### 6A — "Sample Pitch Lock" Checkbox (disable pitch-shift/detune on samples)

**Idea:** A checkbox on the instrument settings panel that, when enabled, tells the synth to play custom samples at their original pitch regardless of the note's interval, pitch-shift, or detune. This keeps breakbeats from getting chipmunk-voice'd when played across the keyboard — essential for breakcore where you want to map a drum break across notes without it sounding like a toy piano.

**Design:**
- New instrument field: `public samplePitchLock: boolean = false;`
- In the chip synth path (`Synth.computeTone` → phase delta calculation for chip/custom-sampled instruments), when `instrument.samplePitchLock` is true:
  - Ignore `pitchShift` and `detune` effects contribution to `intervalStart`/`intervalEnd`
  - Clamp the per-voice phase delta to the sample's `rootKey` instead of applying the note's pitch interval
- In the AudioWorklet `BreakBoxProcessor`, the `note_on` command needs to carry a `samplePitchLock` flag so the worklet can skip pitch-scaling on sample playback
- The `NoteVoice` interface gets `samplePitchLock: boolean`

**Files touched:**
- `synth/synth.ts` — Instrument class field + phase delta calculation in `computeTone`
- `synth/SynthConfig.ts` — serialization (toJsonObject/fromJsonObject) for `samplePitchLock`
- `synth/AudioEngineApi.ts` — add `samplePitchLock` to `NoteVoice`
- `synth/BreakBoxProcessor.ts` — handle the flag in `renderVoice` for sample playback
- `editor/ChannelSettingsPrompt.ts` — checkbox UI
- `editor/PatternEditor.ts` or instrument settings — wire the checkbox to instrument state

### 6B — Per-Note Custom Samples (multi-sample instrument type)

**Idea:** A new instrument type (or mode) where you can map specific samples to specific notes/keys on the piano roll. You'd create a "multi-sample instrument" and in settings assign a custom sample URL to each note (e.g., C3 → breakbeat A, D3 → breakbeat B, F3 → breakbeat C).

**Design:**
- New `InstrumentType.multiSample` added to the enum
- `Instrument` gets `sampleMap: Map<number, SampleEntry>` — maps MIDI pitch number → sample metadata (URL, rootKey, sampleRate, loop settings)
- When a note is played and the instrument is `multiSample` type, the synth looks up `sampleMap.get(pitch)` and loads that sample; if no entry exists for that pitch, falls back to a default sample
- The `NoteVoice` interface already has `sampleKey: string | null` — this can carry the resolved sample key
- UI: a new `editor/SampleMapPrompt.ts` (referenced in Phase 4) with a virtual keyboard for drag-and-drop sample assignment per key
- Backward compatibility: `multiSample` instrument type serialized as a new enum value; old versions ignore it

**Data model:**
- `sampleMap` stored as a dictionary `{ pitch: sampleEntry }` in the instrument's JSON
- Sample entries reuse the existing `SampleEntry` format from `AddSamplesPrompt.ts`
- URL scheme: samples assigned per-note are included in the song URL just like existing custom samples, but keyed by pitch

**Files touched:**
- `synth/SynthConfig.ts` — new `InstrumentType.multiSample`, `sampleMap` field, serialization
- `synth/synth.ts` — Instrument class field, sample lookup in `computeTone`/`loopableChipSynth`, `getInstrumentSynthFunction` for multi-sample type
- `synth/AudioEngineApi.ts` — already has `sampleKey` on `NoteVoice`, may need `multiSampleRootKey` for pitch calculation
- `synth/BreakBoxProcessor.ts` — handle per-note sample lookup
- `synth/BreakBoxAudioEngine.ts` — serialize sample map to worklet
- `editor/ChannelSettingsPrompt.ts` — instrument type dropdown entry + sample map button
- `editor/SampleMapPrompt.ts` — new file, per-key sample assignment UI (from Phase 4 plan)

---

## ⚠️ Technical Constraints & Risks
- **No Server Dependency**: Must work without COOP/COEP headers; rely on `postMessage` and Transferables.
- **Memory Management**: Use a centralized `SamplePool` in the Worklet to prevent memory bloat when using large sample maps.
- **Browser Compatibility**: Ensure a fallback path for browsers with limited `AudioWorklet` support.
