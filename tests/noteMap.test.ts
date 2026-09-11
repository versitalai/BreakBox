// Tests for the NoteMap extension — Phase 3 of the note routing architecture.

import { noteMapExtension, NoteAction } from '../synth/registries/instrumentExtensions/noteMap';
import { instrumentExtensionRegistry } from '../synth/registries/InstrumentExtension';
import { VoiceMode } from '../synth/registries/VoiceTypes';
import { Instrument } from '../synth/model';

describe('NoteMap extension', () => {
    describe('registry', () => {
        it('should be registered in InstrumentExtensionRegistry', () => {
            expect(instrumentExtensionRegistry.has('noteMap')).toBe(true);
            expect(instrumentExtensionRegistry.get('noteMap')).toBe(noteMapExtension);
        });
    });

    describe('routeNote', () => {
        it('should return null when noteMap is disabled', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = new Map();
            instrument._noteMapEnabled = false;

            const ctx = {
                tone: { pitches: [60], note: null },
                instrument,
                instrumentState: { synthesizer: () => {} },
                defaultSynth: () => {},
            };

            const result = noteMapExtension.routeNote!(ctx as any);
            expect(result).toBeNull();
        });

        it('should return null when noteMap is null', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = null;
            instrument._noteMapEnabled = true;

            const ctx = {
                tone: { pitches: [60], note: null },
                instrument,
                instrumentState: { synthesizer: () => {} },
                defaultSynth: () => {},
            };

            const result = noteMapExtension.routeNote!(ctx as any);
            expect(result).toBeNull();
        });

        it('should return null for unmapped notes', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = new Map<number, NoteAction>([
                [72, { mode: VoiceMode.Replace, sampleUrl: 'test.wav', rootKey: 60, gain: 1.0 }],
            ]);
            instrument._noteMapEnabled = true;

            const ctx = {
                tone: { pitches: [60], note: null },
                instrument,
                instrumentState: { synthesizer: () => {} },
                defaultSynth: () => {},
            };

            const result = noteMapExtension.routeNote!(ctx as any);
            expect(result).toBeNull();
        });

        it('should return Replace voice for mapped note in Replace mode', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = new Map<number, NoteAction>([
                [60, { mode: VoiceMode.Replace, sampleUrl: 'kick.wav', rootKey: 48, gain: 1.5 }],
            ]);
            instrument._noteMapEnabled = true;

            const ctx = {
                tone: { pitches: [60], note: null },
                instrument,
                instrumentState: { synthesizer: () => {} },
                defaultSynth: () => {},
            };

            const result = noteMapExtension.routeNote!(ctx as any);
            expect(result).not.toBeNull();
            expect(result!.length).toBe(1);
            expect(result![0].mode).toBe(VoiceMode.Replace);
            expect(result![0].gain).toBe(1.5);
        });

        it('should return two voices for mapped note in Layer mode', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = new Map<number, NoteAction>([
                [64, { mode: VoiceMode.Layer, sampleUrl: 'snare.wav', rootKey: 60, gain: 0.8 }],
            ]);
            instrument._noteMapEnabled = true;

            const ctx = {
                tone: { pitches: [64], note: null },
                instrument,
                instrumentState: { synthesizer: () => {} },
                defaultSynth: () => {},
            };

            const result = noteMapExtension.routeNote!(ctx as any);
            expect(result).not.toBeNull();
            expect(result!.length).toBe(2);
            expect(result![0].mode).toBe(VoiceMode.Layer);
            expect(result![0].gain).toBe(1.0);
            expect(result![1].mode).toBe(VoiceMode.Layer);
            expect(result![1].gain).toBe(0.8);
        });
    });

    describe('serialize/deserialize', () => {
        it('should return empty array for null noteMap', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = null;
            const data = noteMapExtension.serialize!(instrument);
            expect(data.length).toBe(0);
        });

        it('should return empty array for empty noteMap', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = new Map();
            const data = noteMapExtension.serialize!(instrument);
            expect(data.length).toBe(0);
        });

        it('should round-trip a single note mapping', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = new Map<number, NoteAction>([
                [60, { mode: VoiceMode.Replace, sampleUrl: 'kick.wav', rootKey: 48, gain: 1.5 }],
            ]);

            const data = noteMapExtension.serialize!(instrument);
            expect(data.length).toBeGreaterThan(0);

            const instrument2 = new Instrument(false, false);
            const newIndex = noteMapExtension.deserialize!(instrument2, data, 0);

            expect(newIndex).toBe(data.length);
            expect(instrument2._noteMap).not.toBeNull();
            expect(instrument2._noteMap!.size).toBe(1);
            expect(instrument2._noteMap!.get(60)).toEqual({
                mode: VoiceMode.Replace,
                sampleUrl: 'kick.wav',
                rootKey: 48,
                gain: 1.5,
            });
        });

        it('should round-trip multiple note mappings', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = new Map<number, NoteAction>([
                [60, { mode: VoiceMode.Replace, sampleUrl: 'kick.wav', rootKey: 48, gain: 1.0 }],
                [64, { mode: VoiceMode.Layer, sampleUrl: 'snare.wav', rootKey: 60, gain: 0.8 }],
                [67, { mode: VoiceMode.Replace, sampleUrl: 'hat.wav', rootKey: 72, gain: 0.5 }],
            ]);

            const data = noteMapExtension.serialize!(instrument);
            const instrument2 = new Instrument(false, false);
            noteMapExtension.deserialize!(instrument2, data, 0);

            expect(instrument2._noteMap!.size).toBe(3);
            expect(instrument2._noteMap!.get(60)!.mode).toBe(VoiceMode.Replace);
            expect(instrument2._noteMap!.get(64)!.mode).toBe(VoiceMode.Layer);
            expect(instrument2._noteMap!.get(67)!.gain).toBe(0.5);
        });

        it('should set _noteMapEnabled based on entry count', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = new Map<number, NoteAction>([
                [60, { mode: VoiceMode.Replace, sampleUrl: 'test.wav', rootKey: 60, gain: 1.0 }],
            ]);

            const data = noteMapExtension.serialize!(instrument);
            const instrument2 = new Instrument(false, false);
            noteMapExtension.deserialize!(instrument2, data, 0);

            expect(instrument2._noteMapEnabled).toBe(true);
        });
    });
});
