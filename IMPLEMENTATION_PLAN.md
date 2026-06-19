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

## ⚠️ Technical Constraints & Risks
- **No Server Dependency**: Must work without COOP/COEP headers; rely on `postMessage` and Transferables.
- **Memory Management**: Use a centralized `SamplePool` in the Worklet to prevent memory bloat when using large sample maps.
- **Browser Compatibility**: Ensure a fallback path for browsers with limited `AudioWorklet` support.
