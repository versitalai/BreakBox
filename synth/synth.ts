// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: barrel re-exporting the public surface of synth/ for editor, player, and BreakBoxAudioEngine.
// Public surface preserved EXACTLY as the original monolithic synth.ts: model classes, note/pin types, util functions, Synth.
// Internal helpers (Grain, Tone, InstrumentState, BitFieldReader, base64 tables, ...) stay module-private.

export { clamp, parseFloatWithDefault, parseIntWithDefault } from "./util";
export { NotePin, makeNotePin, Note, Pattern, Operator, CustomAlgorithm, CustomFeedBack, SpectrumWave, HarmonicsWave, FilterControlPoint, FilterSettings, EnvelopeSettings, Instrument, Channel, Song } from "./model";
export { Synth } from "./dsp";
export { Dictionary, DictionaryArray, FilterType, EnvelopeType, InstrumentType, Transition, Chord, Envelope, Config } from "./SynthConfig";
