// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: First built-in InstrumentExtension. Provides per-note sample
// triggering on any instrument type. When a note in the noteMap is triggered,
// the configured sample is played (either layered or replacing the default synth).

import { Instrument } from '../../model';
import { Config, sampleLoadingState } from '../../SynthConfig';
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
/**
 * Sentinel function used by NoteMapExtension voices. The actual synth function
 * is resolved by _routeTone() in dsp.ts which replaces this with Synth.noteMapSampleSynth.
 * This avoids a circular import between noteMap.ts and dsp.ts.
 */
export function noteMapSynthSentinel(): void {
    // This should never be called — _routeTone replaces it with the real function.
    throw new Error("noteMapSynthSentinel called directly — _routeTone should have resolved it");
}

export const noteMapExtension: InstrumentExtension = {
    id: 'noteMap',

    routeNote(ctx: RouteNoteContext): Voice[] | null {
        const instrument = ctx.instrument;

        // Check if this instrument has a note map enabled.
        const noteMap = (instrument as any)._noteMap as Map<number, NoteAction> | null;
        const enabled = (instrument as any)._noteMapEnabled as boolean;
        if (!noteMap || !enabled) return null;

        // Get the note number from the tone's first pitch.
        const tone = ctx.tone;
        const noteNumber = tone.note != null ? tone.note.pitches[0] : tone.pitches[0];

        const action = noteMap.get(noteNumber);
        if (!action) return null;

        // Load the sample wave for this note (cached on the instrument).
        const waveMap = (instrument as any)._noteWaveMap as Map<number, Float32Array> | null;
        const wave = waveMap ? waveMap.get(noteNumber) : null;

        // Set per-note sample data on the tone for the synth function to read.
        if (wave) {
            tone.noteWave = wave;
            tone.noteSampleRootKey = action.rootKey;
            tone.noteSampleGain = action.gain;
            tone.noteSampleRate = 44100; // Default; could be stored per-sample if needed
        } else {
            // No sample loaded yet — skip this voice.
            return null;
        }

        // Use the noteMapSynthId sentinel so _routeTone can resolve to Synth.noteMapSampleSynth.
        if (action.mode === VoiceMode.Replace) {
            return [{
                synthFunction: noteMapSynthSentinel as any,
                tone: ctx.tone,
                mode: VoiceMode.Replace,
                gain: action.gain,
            }];
        } else {
            // Layer: render both the default synth and the sample voice.
            return [
                { synthFunction: ctx.defaultSynth, tone: ctx.tone, mode: VoiceMode.Layer, gain: 1.0 },
                {
                    synthFunction: noteMapSynthSentinel as any,
                    tone: ctx.tone,
                    mode: VoiceMode.Layer,
                    gain: action.gain,
                },
            ];
        }
    },

    onCompute(ctx: ComputeContext): void {
        // Pre-load samples for all notes in the note map.
        // In a real implementation, this would fetch and decode audio.
        // For now, the wave map must be populated externally (e.g., by the editor).
        const instrument = ctx.instrument;
        const noteMap = (instrument as any)._noteMap as Map<number, NoteAction> | null;
        if (!noteMap) return;

        // Resolve mapped URLs to the custom samples already loaded by the song.
        // AddSamplesPrompt reloads the song after editing the custom-sample list, so
        // Config.rawChipWaves is the single source of decoded sample buffers.
        let waveMap = (instrument as any)._noteWaveMap as Map<number, Float32Array> | null;
        if (waveMap == null) {
            waveMap = new Map<number, Float32Array>();
            (instrument as any)._noteWaveMap = waveMap;
        }
        // Keep existing entries when their mapping has not changed. This hook is
        // reached from the renderer, so avoid rebuilding maps or copying waves.
        for (const note of waveMap.keys()) {
            if (!noteMap.has(note)) waveMap.delete(note);
        }
        for (const [note, action] of noteMap) {
            if (!waveMap.has(note)) {
                const wave = findLoadedWave(action.sampleUrl);
                if (wave != null) waveMap.set(note, wave);
            }
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
        // Clear wave cache — samples must be reloaded externally after deserialization.
        (instrument as any)._noteWaveMap = new Map<number, Float32Array>();
        return index;
    },
};


function findLoadedWave(url: string): Float32Array | null {
    const expected = normalizeSampleUrl(url);
    for (const key in sampleLoadingState.urlTable) {
        if (normalizeSampleUrl(sampleLoadingState.urlTable[+key]) !== expected) continue;
        const wave = Config.rawChipWaves[+key];
        if (wave != null && wave.samples.length > 0) return wave.samples;
    }
    return null;
}

function normalizeSampleUrl(url: string): string {
    return url.split("!")[0].split(",")[0].trim();
}

// Register the extension on import.
instrumentExtensionRegistry.register(noteMapExtension);

function clampInt(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value | 0));
}
