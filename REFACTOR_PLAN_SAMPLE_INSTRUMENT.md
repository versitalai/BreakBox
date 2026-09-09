# Sample-Trigger Instrument — Implementation Plan

## Goal
Add a new instrument type that plays a custom sample when a specific note is triggered. Built on the refactored foundation (registries, DI, env abstraction).

## Architecture Overview

```
User picks sample URL + trigger note
        │
        ▼
┌──────────────────┐
│  Instrument       │  type: InstrumentType.sampleTrigger
│  sampleUrl: string│  sampleNote: number (MIDI note to trigger on)
│  sampleGain: number│  sampleRootKey: number (original pitch of sample)
└────────┬─────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐  ┌─────────┐
│  DSP   │  │  Editor  │
│  dsp.ts│  │SongEditor│
└───┬────┘  └────┬────┘
    │             │
    ▼             ▼
┌──────────────────────┐
│  Serialization        │
│  model.ts bit-packing │
└──────────────────────┘
```

---

## Phase A: DSP Render Pipeline

### A1. New instrument type fields on `Instrument` (model.ts)

Add to `Instrument` class (~line 1324):
```typescript
// Sample-trigger instrument fields
public sampleUrl: string = "";           // URL or data URI of the sample
public sampleNote: number = 60;          // MIDI note that triggers playback (default C4)
public sampleRootKey: number = 60;       // Original pitch of the sample (for pitch-shifting)
public sampleGain: number = 1.0;         // Playback gain multiplier
public sampleBuffer: Float32Array | null = null;  // Loaded/decoded sample data
public sampleSampleRate: number = 44100; // Sample rate of the audio data
```

### A2. InstrumentType enum + names (SynthConfig.ts)

- Add `sampleTrigger = 12` to `InstrumentType` enum (line ~86)
- Add `"Sample Trigger"` to `instrumentTypeNames` array (line ~997)
- Add preset entry to `TypePresets`

### A3. InstrumentTypeSpec (new file)

`synth/registries/instrumentTypes/sampleTrigger.ts`:
- Registers with `instrumentTypeRegistry`
- `applyDefaults`: sets `sampleUrl = ""`, `sampleNote = 60`, `sampleRootKey = 60`, `sampleGain = 1.0`

### A4. Synth function (dsp.ts)

New static method `Synth.sampleTriggerSynth()`:
- Signature: `(synth, bufferIndex, roundedSamplesPerTick, tone, instrumentState)`
- Logic:
  1. Check if `tone.pitches[0]` matches `instrument.sampleNote` (or is within range)
  2. If `sampleBuffer` is null, try to load from `sampleUrl` (async — see A5)
  3. On trigger, begin sample playback:
     - Calculate pitch shift: `semitoneOffset = tone.pitches[0] - instrument.sampleRootKey`
     - Phase delta = `2^(semitoneOffset/12) * sampleRate / synth.samplesPerSecond`
  4. Linear interpolation sample playback into `synth.tempMonoInstrumentSampleBuffer`
  5. Apply `sampleGain` and `volumeScale`
  6. Handle sample end (stop or loop)

### A5. Sample loading pipeline

Reuse existing infrastructure:
- `_parseAndConfigureCustomSample` (model.ts:6293) already handles URL → AudioBuffer → Float32Array
- `loadBuiltInSamples` (SynthConfig.ts) handles the actual fetch + decode
- New: `Instrument.loadSampleAsync(url)` method that:
  1. Calls `startLoadingSample` + decode
  2. Stores result in `this.sampleBuffer`
  3. Sets `this.sampleSampleRate`
  4. Emits event when ready (so synth can start playing)

### A6. computeTone integration (dsp.ts ~line 4570)

Add branch for `sampleTrigger`:
```typescript
} else if (instrument.type == InstrumentType.sampleTrigger) {
    baseExpression = Config.chipBaseExpression; // reuse chip expression
    // Pitch is determined by sample + rootKey, not basePitch
    // The synth function handles its own pitch calculation
}
```

### A7. updateWaves integration (dsp.ts ~line 2016)

Add branch for `sampleTrigger`:
```typescript
} else if (instrument.type == InstrumentType.sampleTrigger) {
    this.wave = instrument.sampleBuffer; // reuse wave mechanism for sample data
    this.unisonVoices = 1; // samples are mono, no unison
}
```

### A8. Register in SynthFunctionRegistry

Add to `registerSynthFunctions.ts`:
```typescript
synthFunctionRegistry.register(InstrumentType.sampleTrigger, (instrument: Instrument) => {
    return (Synth as any).sampleTriggerSynth;
});
```

---

## Phase B: Serialization

### B1. New SongTagCode

Add to `SongTagCode` enum in model.ts:
```typescript
sampleData = next_available_code
```

### B2. toBase64String (model.ts ~line 3713)

Add after the type-specific chain:
```typescript
} else if (instrument.type == InstrumentType.sampleTrigger) {
    // Write sample URL as length-prefixed string
    buffer.push(SongTagCode.sampleData);
    buffer.push(base64IntToCharCode[instrument.sampleUrl.length]);
    for (let i = 0; i < instrument.sampleUrl.length; i++) {
        buffer.push(base64IntToCharCode[instrument.sampleUrl.charCodeAt(i) & 63]);
    }
    buffer.push(base64IntToCharCode[instrument.sampleNote]);
    buffer.push(base64IntToCharCode[instrument.sampleRootKey + 64]); // offset to handle negative
    buffer.push(base64IntToCharCode[Math.round(instrument.sampleGain * 10)]);
}
```

### B3. fromBase64String (model.ts ~line 4419+)

Add case in the switch:
```typescript
case SongTagCode.sampleData: {
    const urlLen = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
    let url = "";
    for (let i = 0; i < urlLen; i++) {
        url += String.fromCharCode(base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
    }
    instrument.sampleUrl = url;
    instrument.sampleNote = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
    instrument.sampleRootKey = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] - 64;
    instrument.sampleGain = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] / 10;
    break;
}
```

### B4. Backward compatibility

- Old songs without `sampleData` tag: instrument defaults to empty sampleUrl → silent
- New songs in old players: unknown tag code → skip gracefully (already handled by the `default` case in the switch)

---

## Phase C: Editor UI

### C1. Instrument type dropdown (SongEditor.ts ~line 86)

Add to the pitch channel options:
```typescript
menu.appendChild(option({ value: InstrumentType.sampleTrigger }, EditorConfig.valueToPreset(InstrumentType.sampleTrigger)!.name));
```

### C2. Sample picker row (new UI element)

New row in SongEditor constructor:
```typescript
this._samplePickerRow = div({ class: "selectRow", style: "display: none;" },
    span({ class: "tip" }, "Sample:"),
    input({ type: "text", placeholder: "Paste sample URL...", 
            onchange: () => this._onSampleUrlChange() })
);
this._sampleNoteRow = div({ class: "selectRow", style: "display: none;" },
    span({ class: "tip" }, "Trigger Note:"),
    // note selector dropdown
);
```

### C3. updateInstrumentSettings (SongEditor.ts ~line 2605)

Add branch:
```typescript
if (instrument.type == InstrumentType.sampleTrigger) {
    this._samplePickerRow.style.display = "";
    this._sampleNoteRow.style.display = "";
    this._chipWaveSelectRow.style.display = "none";
    // ... hide other irrelevant rows
} else {
    this._samplePickerRow.style.display = "none";
    this._sampleNoteRow.style.display = "none";
}
```

### C4. Sample loading in editor

`_onSampleUrlChange()`:
1. Set `instrument.sampleUrl = inputValue`
2. Call `instrument.loadSampleAsync(url)` 
3. Show loading indicator
4. On load complete: update `instrument.sampleRootKey` from metadata if available
5. Trigger song re-render

---

## Phase D: Wiring TagHandlerRegistry (Optional/Future)

Defer this. The current approach (inline if/else in model.ts) works and is lower risk. 
TagHandlerRegistry becomes a priority if we add 3+ more instrument types.

---

## File Change Summary

| File | Change |
|------|--------|
| `synth/SynthConfig.ts` | Add `sampleTrigger` to enum + names + presets |
| `synth/model.ts` | Add fields to `Instrument`, serialize/deserialize, `loadSampleAsync` |
| `synth/dsp.ts` | `sampleTriggerSynth()` method, `computeTone` + `updateWaves` branches |
| `synth/registries/instrumentTypes/sampleTrigger.ts` | **NEW** — type spec |
| `synth/registries/registerSynthFunctions.ts` | Register sampleTrigger synth fn |
| `editor/widgets/SongEditor.ts` | Dropdown entry, sample picker row, UI wiring |
| `editor/core/EditorConfig.ts` | Add preset for sampleTrigger |
| `tests/sampleTrigger.test.ts` | **NEW** — regression tests |

## Risk Assessment

- **Low risk**: New files (spec, tests, UI row)
- **Medium risk**: dsp.ts changes (new synth function + computeTone/updateWaves branches)
- **High risk**: model.ts serialization changes (must not break existing song URLs)

## Estimated Effort

- Phase A (DSP): ~4-6 hours — most complex, need to handle async sample loading
- Phase B (Serialization): ~2 hours — straightforward bit-packing
- Phase C (UI): ~2-3 hours — DOM code following existing patterns
- Tests: ~1 hour

**Total: ~9-12 hours across 4-6 commits**
