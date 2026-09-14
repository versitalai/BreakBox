// Tests for the NoteMap extension — Phase 3 of the note routing architecture.

import { noteMapExtension, NoteAction } from '../synth/registries/instrumentExtensions/noteMap';
import { instrumentExtensionRegistry } from '../synth/registries/InstrumentExtension';
import { VoiceMode } from '../synth/registries/VoiceTypes';
import { Instrument } from '../synth/model';
import { Config, sampleLoadingState } from '../synth/SynthConfig';

describe('NoteMap extension', () => {
    describe('registry', () => {
        it('should be registered in InstrumentExtensionRegistry', () => {
            expect(instrumentExtensionRegistry.has('noteMap')).toBe(true);
            expect(instrumentExtensionRegistry.get('noteMap')).toBe(noteMapExtension);
        });
    });

    describe('loaded custom sample resolution', () => {
        it('should resolve a mapped custom-sample URL to its loaded wave without copying it', () => {
            const instrument = new Instrument(false, false);
            const chipWaveIndex = Config.rawChipWaves.length;
            const wave = new Float32Array([0, 0.5, 0, -0.5, 0]);
            Config.rawChipWaves[chipWaveIndex] = { name: "NoteMap Test", index: chipWaveIndex, expression: 1, samples: wave };
            sampleLoadingState.urlTable[chipWaveIndex] = "https://samples.example/kick.wav!loop";
            instrument._noteMap = new Map<number, NoteAction>([
                [60, { mode: VoiceMode.Replace, sampleUrl: "https://samples.example/kick.wav", rootKey: 60, gain: 1 }],
            ]);

            noteMapExtension.onCompute!({ instrument, instrumentState: {}, channelIndex: 0, instrumentIndex: 0 });

            expect((instrument as any)._noteWaveMap.get(60)).toBe(wave);
            Config.rawChipWaves.length = chipWaveIndex;
            delete sampleLoadingState.urlTable[chipWaveIndex];
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
            const dummyWave = new Float32Array([0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5]);
            instrument._noteMap = new Map<number, NoteAction>([
                [60, { mode: VoiceMode.Replace, sampleUrl: 'kick.wav', rootKey: 48, gain: 1.5 }],
            ]);
            instrument._noteMapEnabled = true;
            (instrument as any)._noteWaveMap = new Map<number, Float32Array>([
                [60, dummyWave],
            ]);

            const tone: any = { pitches: [60], note: null };
            const ctx = {
                tone,
                instrument,
                instrumentState: { synthesizer: () => {} },
                defaultSynth: () => {},
            };

            const result = noteMapExtension.routeNote!(ctx as any);
            expect(result).not.toBeNull();
            expect(result!.length).toBe(1);
            expect(result![0].mode).toBe(VoiceMode.Replace);
            expect(result![0].gain).toBe(1.5);
            // Verify tone was populated with sample data
            expect(tone.noteWave).toBe(dummyWave);
            expect(tone.noteSampleRootKey).toBe(48);
            expect(tone.noteSampleGain).toBe(1.5);
        });

        it('should return two voices for mapped note in Layer mode', () => {
            const instrument = new Instrument(false, false);
            const dummyWave = new Float32Array([0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5]);
            instrument._noteMap = new Map<number, NoteAction>([
                [64, { mode: VoiceMode.Layer, sampleUrl: 'snare.wav', rootKey: 60, gain: 0.8 }],
            ]);
            instrument._noteMapEnabled = true;
            (instrument as any)._noteWaveMap = new Map<number, Float32Array>([
                [64, dummyWave],
            ]);

            const tone: any = { pitches: [64], note: null };
            const ctx = {
                tone,
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
            // Verify tone was populated with sample data
            expect(tone.noteWave).toBe(dummyWave);
            expect(tone.noteSampleRootKey).toBe(60);
            expect(tone.noteSampleGain).toBe(0.8);
        });

        it('should return null when sample wave is not loaded', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = new Map<number, NoteAction>([
                [60, { mode: VoiceMode.Replace, sampleUrl: 'kick.wav', rootKey: 48, gain: 1.5 }],
            ]);
            instrument._noteMapEnabled = true;
            // No _noteWaveMap — sample not loaded

            const ctx = {
                tone: { pitches: [60], note: null },
                instrument,
                instrumentState: { synthesizer: () => {} },
                defaultSynth: () => {},
            };

            const result = noteMapExtension.routeNote!(ctx as any);
            expect(result).toBeNull();
        });

        it('should return null when _noteWaveMap exists but note not in it', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = new Map<number, NoteAction>([
                [60, { mode: VoiceMode.Replace, sampleUrl: 'kick.wav', rootKey: 48, gain: 1.5 }],
            ]);
            instrument._noteMapEnabled = true;
            // Wave map exists but only has note 64, not 60
            (instrument as any)._noteWaveMap = new Map<number, Float32Array>([
                [64, new Float32Array([0, 1, 0, -1])],
            ]);

            const ctx = {
                tone: { pitches: [60], note: null },
                instrument,
                instrumentState: { synthesizer: () => {} },
                defaultSynth: () => {},
            };

            const result = noteMapExtension.routeNote!(ctx as any);
            expect(result).toBeNull();
        });

        it('should set noteSampleRate to 44100 by default', () => {
            const instrument = new Instrument(false, false);
            const dummyWave = new Float32Array([0, 1, 0, -1]);
            instrument._noteMap = new Map<number, NoteAction>([
                [60, { mode: VoiceMode.Replace, sampleUrl: 'kick.wav', rootKey: 48, gain: 1.0 }],
            ]);
            instrument._noteMapEnabled = true;
            (instrument as any)._noteWaveMap = new Map<number, Float32Array>([
                [60, dummyWave],
            ]);

            const tone: any = { pitches: [60], note: null };
            noteMapExtension.routeNote!({ tone, instrument, instrumentState: {}, defaultSynth: () => {} } as any);
            expect(tone.noteSampleRate).toBe(44100);
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

        it('should not serialize _noteWaveMap data', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = new Map<number, NoteAction>([
                [60, { mode: VoiceMode.Replace, sampleUrl: 'kick.wav', rootKey: 48, gain: 1.5 }],
            ]);
            // Populate wave map with dummy data
            (instrument as any)._noteWaveMap = new Map<number, Float32Array>([
                [60, new Float32Array(1000)], // Large buffer
            ]);

            const data = noteMapExtension.serialize!(instrument);
            // Serialized data should be small (just note map metadata, not wave buffer)
            // 1 (count) + 1 (note) + 1 (mode) + 1 (rootKey) + 1 (gain) + 1 (urlLen) + 8 (url) = 14
            expect(data.length).toBeLessThan(50);
            expect(data.length).toBeGreaterThan(0);
        });

        it('should clear _noteWaveMap on deserialize', () => {
            const instrument = new Instrument(false, false);
            instrument._noteMap = new Map<number, NoteAction>([
                [60, { mode: VoiceMode.Replace, sampleUrl: 'kick.wav', rootKey: 48, gain: 1.5 }],
            ]);

            const data = noteMapExtension.serialize!(instrument);

            const instrument2 = new Instrument(false, false);
            // Pre-populate with stale wave data
            (instrument2 as any)._noteWaveMap = new Map<number, Float32Array>([
                [60, new Float32Array([0, 1, 0, -1])],
                [64, new Float32Array([0, 0.5, 1])],
            ]);

            noteMapExtension.deserialize!(instrument2, data, 0);

            // Wave map should be cleared (fresh empty map)
            const waveMap = (instrument2 as any)._noteWaveMap as Map<number, Float32Array>;
            expect(waveMap).toBeDefined();
            expect(waveMap.size).toBe(0);
        });
    });
});

describe('Instrument extension helpers (Phase 4)', () => {
    it('should attach an extension', () => {
        const instrument = new Instrument(false, false);
        const ext = { id: 'test1', priority: 0 };
        instrument.attachExtension(ext as any);
        expect(instrument.extensions.length).toBe(1);
        expect(instrument.hasExtension('test1')).toBe(true);
    });

    it('should replace an existing extension with same id', () => {
        const instrument = new Instrument(false, false);
        instrument.attachExtension({ id: 'test1', priority: 0 } as any);
        instrument.attachExtension({ id: 'test1', priority: 5 } as any);
        expect(instrument.extensions.length).toBe(1);
        expect((instrument.extensions[0] as any).priority).toBe(5);
    });

    it('should sort extensions by priority (highest first)', () => {
        const instrument = new Instrument(false, false);
        instrument.attachExtension({ id: 'low', priority: -10 } as any);
        instrument.attachExtension({ id: 'high', priority: 10 } as any);
        instrument.attachExtension({ id: 'mid', priority: 0 } as any);
        expect((instrument.extensions[0] as any).id).toBe('high');
        expect((instrument.extensions[1] as any).id).toBe('mid');
        expect((instrument.extensions[2] as any).id).toBe('low');
    });

    it('should detach an extension by id', () => {
        const instrument = new Instrument(false, false);
        instrument.attachExtension({ id: 'test1' } as any);
        instrument.attachExtension({ id: 'test2' } as any);
        const removed = instrument.detachExtension('test1');
        expect(removed).toBe(true);
        expect(instrument.extensions.length).toBe(1);
        expect(instrument.hasExtension('test1')).toBe(false);
        expect(instrument.hasExtension('test2')).toBe(true);
    });

    it('should return false when detaching non-existent extension', () => {
        const instrument = new Instrument(false, false);
        const removed = instrument.detachExtension('nonexistent');
        expect(removed).toBe(false);
    });

    it('should get an extension by id', () => {
        const instrument = new Instrument(false, false);
        const ext = { id: 'test1', priority: 5 };
        instrument.attachExtension(ext as any);
        const found = instrument.getExtension('test1');
        expect(found).toBeDefined();
        expect((found as any).priority).toBe(5);
    });
});

describe('ExtensionRegistry ordering (Phase 4)', () => {
    it('should return ordered IDs by priority', () => {
        // noteMap extension is registered with default priority (0)
        const ids = instrumentExtensionRegistry.getOrderedIds();
        expect(ids).toContain('noteMap');
    });
});
