# Note Routing Architecture

## Goal

Make BreakBox's audio pipeline **open-ended** — so that per-note behaviors (play a sample when note X triggers, replace a note's synthesis with a sample, layer additional voices, etc.) are natural plug-in extensions rather than one-off hacks.

This doc describes the architecture. It does **not** implement any specific feature. It defines the hook points that features will later plug into.

---

## Current Pipeline (What Exists Today)

```
Note (pitch, instrumentIndex)
  │
  ▼
determineCurrentActiveTones()        [dsp.ts:4255]
  │  creates Tone, calls computeTone()
  ▼
computeTone()                         [dsp.ts:4514]
  │  has access to Instrument, InstrumentState, Tone
  │  calls instrumentState.compute() which sets instrumentState.synthesizer
  ▼
playTone()                            [dsp.ts:4471]
  │  invokes instrumentState.synthesizer!(synth, bufferIndex, runLength, tone, instrumentState)
  ▼
synth function writes to synth.tempMonoInstrumentSampleBuffer
  │
  ▼
effectsSynth() per instrumentState    [dsp.ts:3466]
  │
  ▼
mix into outputDataL/outputDataR
```

**The problem:** This is a single chain. One note → one synth function → one buffer write. There's no hook point to say "for this note, also do X" or "for this note, do X instead."

---

## Architecture Overview

Introduce a **NoteRouter** between `determineCurrentActiveTones` and `playTone`. The router inspects each tone and produces a list of **Voice** objects — each voice is an independent synth render that contributes to the final mix.

```
Note
  │
  ▼
determineCurrentActiveTones()
  │  creates Tone (unchanged)
  ▼
computeTone()                         [MODIFIED: also calls router]
  │  router inspects tone + instrument
  │  produces Voice[] for this tone
  ▼
playTone()                            [MODIFIED: iterates voices]
  │  for each Voice in tone.voices[]:
  │    voice.synthFunction(synth, bufferIndex, runLength, voice.tone, instrumentState)
  ▼
all voices write to tempMonoInstrumentSampleBuffer (accumulation)
  │
  ▼
effectsSynth() → mix (unchanged)
```

---

## Core Abstractions

### 1. Voice

A Voice is a single synth render for one note trigger. One Tone can produce one or more Voices.

```typescript
interface Voice {
    /** The synth function to call (replaces instrumentState.synthesizer for this render). */
    synthFunction: SynthFunction;
    /** The tone to render (may be a copy of the original, or a modified version). */
    tone: Tone;
    /** Whether this voice replaces the default synthesis (true) or layers on top (false). */
    mode: VoiceMode;
    /** Optional gain multiplier for this voice. */
    gain: number;
}

enum VoiceMode {
    /** Layers on top of the default instrument synthesis. */
    Layer,
    /** Replaces the default instrument synthesis entirely for this note. */
    Replace,
}
```

### 2. NoteRouter

The router is called during `computeTone()` for each tone. It decides which voices should render.

```typescript
type NoteRouter = (
    tone: Tone,
    instrument: Instrument,
    instrumentState: InstrumentState,
    defaultSynth: Function
) => Voice[];
```

**Default router:** Returns a single Voice with `mode: Layer`, `synthFunction: defaultSynth`, `tone: tone`. This preserves 100% of current behavior.

**Custom routers:** Can inspect `tone.pitches[0]` (the note number), `instrument.type`, or any per-instrument data to decide:
- "For note 60, also play sample X" → return [defaultVoice, sampleVoice]
- "For note 64, replace with sample Y" → return [sampleVoice] (Replace mode)
- "For all notes, layer a detuned copy" → return [defaultVoice, detunedVoice]

### 3. Instrument Note Map

Instruments gain an optional `noteMap` field — a sparse mapping from note number to a note action.

```typescript
interface NoteAction {
    /** What to do when this note triggers. */
    mode: VoiceMode;
    /** URL of the sample to play (loaded into sampleBuffer). */
    sampleUrl?: string;
    /** Root key of the sample for pitch correction. */
    rootKey?: number;
    /** Gain for this voice (0-2). */
    gain?: number;
    /** Which synth function to use (defaults to sampleTriggerSynth). */
    synthType?: string;
}

// On Instrument class:
public noteMap: Map<number, NoteAction> | null = null;
public noteMapEnabled: boolean = false;
```

This is the data model that the keymap UI would edit. The router reads it.

### 4. Extension Slot (Future-Proofing)

Rather than hardcoding "note maps" as the only per-note behavior, the Instrument gets a generic `extensions` slot:

```typescript
interface InstrumentExtension {
    readonly id: string;
    /** Called during computeTone to produce additional/replacement voices. */
    routeNote?: NoteRouter;
    /** Called once per instrumentState.compute() for setup. */
    onCompute?: (instrumentState: InstrumentState, instrument: Instrument) => void;
    /** Serialization. */
    serialize: (instrument: Instrument) => number[];
    deserialize: (instrument: Instrument, data: number[], index: number) => number; // returns new index
}

// On Instrument class:
public extensions: InstrumentExtension[] = [];
```

The `noteMap` feature becomes one built-in extension (`NoteMapExtension`) that implements `InstrumentExtension`. Future extensions (MIDI-controlled triggers, probability-based variations, per-note effect overrides) follow the same interface.

---

## Hook Points in the DSP Pipeline

### Hook 1: `computeTone()` — Router Invocation

**Current (dsp.ts:4514):**
```typescript
private computeTone(song, channelIndex, samplesPerTick, tone, ...): void {
    // ... setup ...
    instrumentState.compute(this, instrument, ...);
    // ... pitch/envelope computation ...
}
```

**After refactor:**
```typescript
private computeTone(song, channelIndex, samplesPerTick, tone, ...): void {
    // ... setup (unchanged) ...
    instrumentState.compute(this, instrument, ...);
    // ... pitch/envelope computation (unchanged) ...

    // NEW: Route the tone into voices
    const defaultSynth = instrumentState.synthesizer!;
    tone.voices = this._routeTone(tone, instrument, instrumentState, defaultSynth);
}
```

### Hook 2: `playTone()` — Voice Iteration

**Current (dsp.ts:4471):**
```typescript
private playTone(channelIndex, bufferIndex, runLength, tone): void {
    const instrumentState = this.channels[channelIndex].instruments[tone.instrumentIndex];
    if (instrumentState.synthesizer != null)
        instrumentState.synthesizer!(this, bufferIndex, runLength, tone, instrumentState);
    tone.envelopeComputer.clearEnvelopes();
    instrumentState.envelopeComputer.clearEnvelopes();
}
```

**After refactor:**
```typescript
private playTone(channelIndex, bufferIndex, runLength, tone): void {
    const instrumentState = this.channels[channelIndex].instruments[tone.instrumentIndex];
    const voices = tone.voices ?? [defaultVoice(tone, instrumentState.synthesizer!)];
    for (const voice of voices) {
        voice.synthFunction(this, bufferIndex, runLength, voice.tone, instrumentState);
    }
    tone.envelopeComputer.clearEnvelopes();
    instrumentState.envelopeComputer.clearEnvelopes();
}
```

### Hook 3: `Tone.voices` — Voice Storage

Add to the Tone class (dsp.ts:874):
```typescript
public voices: Voice[] | null = null;
```

The voices array is populated during `computeTone` and consumed during `playTone`. It's transient — lives only for the duration of one tick's rendering.

---

## Behavior Preservation Guarantees

1. **Default router = identity.** With no extensions registered, the router returns `[defaultVoice]` and behavior is identical to today.
2. **No perf cost when unused.** `noteMapEnabled === false` and `extensions.length === 0` → router returns early with the default voice. No allocation, no iteration overhead.
3. **Synth functions unchanged.** All existing synth functions (chip, FM, sampleTrigger, etc.) continue to work exactly as before. They receive the same `(synth, bufferIndex, runLength, tone, instrumentState)` signature.
4. **Serialization backward-compatible.** New fields (`noteMap`, `extensions`) are only serialized when non-empty. Old clients ignore unknown tag codes.
5. **Effects chain unchanged.** All voices for one instrument share the same `instrumentState` effects pipeline. Effects are applied once per instrument, not per voice.

---

## Extension Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│  InstrumentState.compute()                                   │
│  ├─ Set instrumentState.synthesizer (existing)              │
│  ├─ Call extension.onCompute() for each extension            │
│  └─ Load sample buffers, allocate state, etc.               │
├─────────────────────────────────────────────────────────────┤
│  computeTone()                                               │
│  ├─ Compute pitch/expression (existing)                     │
│  ├─ Call extension.routeNote() → Voice[]                    │
│  └─ Store voices on tone.voices                             │
├─────────────────────────────────────────────────────────────┤
│  playTone()                                                  │
│  ├─ For each voice: call voice.synthFunction()              │
│  └─ All voices accumulate into tempMonoInstrumentSampleBuffer│
├─────────────────────────────────────────────────────────────┤
│  effectsSynth()                                              │
│  └─ Per-instrument effects applied to accumulated buffer     │
└─────────────────────────────────────────────────────────────┘
```

---

## What This Enables (Future Features)

| Feature | How it plugs in |
|---------|----------------|
| **Per-note sample layering** | `NoteMapExtension` with `mode: Layer` |
| **Per-note sample replacement** | `NoteMapExtension` with `mode: Replace` |
| **Probability-based sample triggers** | Custom extension with `routeNote` that rolls dice |
| **Per-note effect overrides** | Extension that swaps `instrumentState` effects per voice |
| **MIDI-controlled triggers** | Extension that reads MIDI CC and routes accordingly |
| **Note transposition / harmony** | Extension that adds detuned/pitched voices |
| **Round-robin samples** | Extension that cycles through multiple samples per note |

---

## Implementation Phases

### Phase 1: Core Hooks (no new features)
- Add `Voice` interface, `VoiceMode` enum
- Add `Tone.voices` field
- Add `_routeTone()` method with default identity behavior
- Modify `playTone()` to iterate voices
- **Zero behavior change** — all existing tests pass unchanged

### Phase 2: Extension Slot on Instrument
- Add `InstrumentExtension` interface
- Add `Instrument.extensions` field
- Wire `onCompute` and `routeNote` into the lifecycle
- Add serialization support (new tag codes)

### Phase 3: NoteMapExtension (first consumer)
- Implement the keymap as an `InstrumentExtension`
- Add `noteMap` / `noteMapEnabled` fields to Instrument
- Serialization for note map data
- Editor UI (separate effort)

### Phase 4: Registry for Extensions
- `ExtensionRegistry` (like `InstrumentTypeRegistry`)
- Third-party extensions can register without modifying core code
- Extension discovery, ordering, priority

---

## Open Questions

1. **Should voices have independent effects chains?** Currently all voices share `instrumentState` effects. Per-voice effects would require separate buffer accumulation — significant complexity. Recommendation: defer.

2. **Should the router be global or per-instrument?** Both. A global router catches all notes (useful for song-wide effects). Per-instrument extensions handle instrument-specific behavior. Global router runs first, per-instrument extensions can modify the result.

3. **Sample lifecycle for note-mapped samples.** Samples in the note map need to be loaded into `Float32Array` buffers. Should they live on the `NoteAction` (shared) or be copied per-instrument? Recommendation: load once, store in a sample cache, reference by URL.

4. **Undo/redo for note map edits.** The existing `Change` pattern in `editor/core/changes.ts` should extend naturally — each note map edit is a `Change` object. No architectural changes needed.

---

## Key Files

| File | Role |
|------|------|
| `synth/dsp.ts` | DSP pipeline — `playTone`, `computeTone`, `Tone` class |
| `synth/model.ts` | `Instrument` class — new fields |
| `synth/format.ts` | `SongTagCode` enum — new tag codes |
| `synth/registries/` | Registry patterns to follow |
| `editor/core/changes.ts` | Undo/redo pattern for editor changes |
| `editor/widgets/SongEditor.ts` | Editor UI (Phase 3+) |
