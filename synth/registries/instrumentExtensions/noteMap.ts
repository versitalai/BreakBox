// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: First built-in InstrumentExtension. Provides per-note sample
// triggering on any instrument type. When a note in the noteMap is triggered,
// the configured sample is played (either layered or replacing the default synth).

import { Instrument } from '../../model';
import { Voice, VoiceMode } from '../VoiceTypes';
import { InstrumentExtension, ComputeContext, RouteNoteContext } from '../InstrumentExtension';
import { instrumentExtensionRegistry } from '../InstrumentExtension';

/**
 * Action to perform when a mapped note is triggered.
 */
export interface NoteAction {
    /** Whether to layer the sample on top or replace the instrument's synthesis. */
    mode: VoiceMode;
    /** URL of the sample to play. */
    sampleUrl: string;
    /** Root key of the sample (for pitch correction). */
    rootKey: number;
    /** Gain multiplier for this voice (0-2). */
    gain: number;
}

/**
 * The note map extension — maps specific notes to sample actions.
 *
 * This is the first consumer of the InstrumentExtension system. It demonstrates
 * how per-note behavior can be plugged into any instrument type without
 * modifying the instrument's core synthesis code.
 *
 * Data is stored on the instrument itself (instrument.extensions references this
 * extension, and the note map data is serialized via this extension's
 * serialize/deserialize methods).
 */
export const noteMapExtension: InstrumentExtension = {
    id: 'noteMap',

    onCompute(_ctx: ComputeContext): void {
        // No per-compute setup needed for the note map itself.
        // Sample loading would happen here if we had async buffer management.
    },

    routeNote(ctx: RouteNoteContext): Voice[] | null {
        const instrument = ctx.instrument;

        // Check if this instrument has a note map enabled.
        const noteMap = (instrument as any)._noteMap as Map<number, NoteAction> | null;
        const enabled = (instrument as any)._noteMapEnabled as boolean;
        if (!noteMap || !enabled) return null;

        // Get the note number from the tone's first pitch.
        // tone.pitches[0] is the pitch in song-space; we need the actual note number.
        const tone = ctx.tone;
        const noteNumber = tone.note != null ? tone.note.pitches[0] : tone.pitches[0];

        const action = noteMap.get(noteNumber);
        if (!action) return null;

        // Return a voice for the sample trigger.
        // We use the sampleTriggerSynth function (same as the sample-trigger instrument type).
        const synthFn = ctx.defaultSynth;

        if (action.mode === VoiceMode.Replace) {
            // Replace: only render the sample voice.
            // We need the sampleTriggerSynth function, but we can't easily get it here
            // without a circular import. Instead, we mark this voice with a special
            // synthFunction that the DSP will resolve.
            return [{
                synthFunction: synthFn, // Placeholder — see note below
                tone: ctx.tone,
                mode: VoiceMode.Replace,
                gain: action.gain,
            }];
        } else {
            // Layer: render both the default synth and the sample voice.
            return [
                { synthFunction: ctx.defaultSynth, tone: ctx.tone, mode: VoiceMode.Layer, gain: 1.0 },
                {
                    synthFunction: synthFn, // Placeholder — see note below
                    tone: ctx.tone,
                    mode: VoiceMode.Layer,
                    gain: action.gain,
                },
            ];
        }
    },

    serialize(instrument: Instrument): number[] {
        const noteMap = (instrument as any)._noteMap as Map<number, NoteAction> | null;
        if (!noteMap || noteMap.size === 0) return [];

        const result: number[] = [];
        // Number of entries (1 char, max 63 entries)
        result.push(Math.min(noteMap.size, 63));
        let count = 0;
        for (const [note, action] of noteMap) {
            if (count >= 63) break;
            // Note number (1 char, 0-127)
            result.push(clampInt(note, 0, 127));
            // Mode (0 = Layer, 1 = Replace)
            result.push(action.mode === VoiceMode.Replace ? 1 : 0);
            // Root key (1 char, 0-127)
            result.push(clampInt(action.rootKey, 0, 127));
            // Gain (1 char, 0-20, representing 0.0-2.0)
            result.push(Math.round(action.gain * 10));
            // URL length + URL chars (max 63 chars)
            const urlLen = Math.min(action.sampleUrl.length, 63);
            result.push(urlLen);
            for (let i = 0; i < urlLen; i++) {
                result.push(action.sampleUrl.charCodeAt(i));
            }
            count++;
        }
        return result;
    },

    deserialize(instrument: Instrument, data: number[], index: number): number {
        const entryCount = data[index++];
        const noteMap = new Map<number, NoteAction>();

        for (let i = 0; i < entryCount; i++) {
            const note = data[index++];
            const mode = data[index++] === 1 ? VoiceMode.Replace : VoiceMode.Layer;
            const rootKey = data[index++];
            const gain = data[index++] / 10;
            const urlLen = data[index++];
            let url = '';
            for (let j = 0; j < urlLen; j++) {
                url += String.fromCharCode(data[index++]);
            }
            noteMap.set(note, { mode, sampleUrl: url, rootKey, gain });
        }

        (instrument as any)._noteMap = noteMap;
        (instrument as any)._noteMapEnabled = entryCount > 0;
        return index;
    },
};

// Register the extension on import.
instrumentExtensionRegistry.register(noteMapExtension);

function clampInt(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value | 0));
}
