// Copyright (c) 2012-2022 John Eskety and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Shared types for the note routing system.
//   Imported by dsp.ts (Tone class, playTone, computeTone),
//   InstrumentExtension.ts (extension interface), and future extension modules.
//
// This file must NOT import from dsp.ts, model.ts, or any registry to avoid
// circular dependencies. It defines only the core Voice/VoiceMode types.

/**
 * Mode for a voice produced by the note router.
 */
export enum VoiceMode {
    /** Layers on top of the default instrument synthesis. */
    Layer,
    /** Replaces the default instrument synthesis entirely for this note. */
    Replace,
}

/**
 * A single synth render for one note trigger. One Tone can produce
 * one or more Voices via the note router.
 */
export interface Voice {
    /** The synth function to call. */
    synthFunction: Function;
    /** The tone to render (may be a copy or modified version). */
    tone: any; // Tone — typed as any to avoid circular import with dsp.ts
    /** Whether this voice replaces or layers on top. */
    mode: VoiceMode;
    /** Optional gain multiplier for this voice. */
    gain: number;
}
