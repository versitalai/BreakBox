// Regression test: Sample-trigger instrument type.
//
// Verifies that the new sampleTrigger instrument type is properly registered,
// serialized/deserialized, and produces correct defaults.

import { Song } from '../synth/model';
import { InstrumentType, Config, TypePresets } from '../synth/SynthConfig';
import { instrumentTypeRegistry } from '../synth/registries/InstrumentTypeRegistry';
import { synthFunctionRegistry } from '../synth/registries/SynthFunctionRegistry';

// Import registry registrations (side-effect)
import '../synth/registries/InstrumentTypes';
import '../synth/registries/registerSynthFunctions';

// Mock browser globals
(globalThis as any).OFFLINE = false;

describe('SampleTrigger instrument', () => {
    it('should be registered in InstrumentTypeRegistry', () => {
        expect(instrumentTypeRegistry.has(InstrumentType.sampleTrigger)).toBe(true);
    });

    it('should have correct properties in registry spec', () => {
        const spec = instrumentTypeRegistry.get(InstrumentType.sampleTrigger);
        expect(spec.type).toBe(InstrumentType.sampleTrigger);
        expect(spec.isNoise).toBe(false);
        expect(spec.hasSpecialInterval).toBe(false);
        expect(spec.isChipLike).toBe(false);
        expect(spec.displayName).toBe('sample trigger');
    });

    it('should be registered in SynthFunctionRegistry', () => {
        expect(synthFunctionRegistry.has(InstrumentType.sampleTrigger)).toBe(true);
    });

    it('should apply correct defaults via setTypeAndReset', () => {
        const song = new Song();
        song.channels[0].instruments[0].setTypeAndReset(InstrumentType.sampleTrigger, false, false);
        const inst = song.channels[0].instruments[0];
        expect(inst.type).toBe(InstrumentType.sampleTrigger);
        expect(inst.sampleUrl).toBe('');
        expect(inst.sampleNote).toBe(60);
        expect(inst.sampleRootKey).toBe(60);
        expect(inst.sampleGain).toBe(1.0);
        expect(inst.sampleBuffer).toBeNull();
        expect(inst.sampleSampleRate).toBe(44100);
    });

    it('should be in instrumentTypeNames', () => {
        expect(Config.instrumentTypeNames[InstrumentType.sampleTrigger]).toBe('sample trigger');
    });

    it('should be in TypePresets', () => {
        expect(TypePresets).toContain('sample trigger');
    });

    it('should serialize and deserialize sampleTrigger fields', () => {
        const song = new Song();
        const inst = song.channels[0].instruments[0];
        inst.setTypeAndReset(InstrumentType.sampleTrigger, false, false);
        inst.sampleUrl = 'https://example.com/sample.wav';
        inst.sampleNote = 48;
        inst.sampleRootKey = 55;
        inst.sampleGain = 0.8;

        const serialized = song.toBase64String();
        const song2 = new Song();
        song2.fromBase64String(serialized);
        const inst2 = song2.channels[0].instruments[0];

        expect(inst2.type).toBe(InstrumentType.sampleTrigger);
        expect(inst2.sampleUrl).toBe('https://example.com/sample.wav');
        expect(inst2.sampleNote).toBe(48);
        expect(inst2.sampleRootKey).toBe(55);
        expect(inst2.sampleGain).toBeCloseTo(0.8, 1);
    });

    it('should handle empty sample URL in round-trip', () => {
        const song = new Song();
        const inst = song.channels[0].instruments[0];
        inst.setTypeAndReset(InstrumentType.sampleTrigger, false, false);

        const serialized = song.toBase64String();
        const song2 = new Song();
        song2.fromBase64String(serialized);
        const inst2 = song2.channels[0].instruments[0];

        expect(inst2.type).toBe(InstrumentType.sampleTrigger);
        expect(inst2.sampleUrl).toBe('');
    });

    it('should not break existing instrument type count', () => {
        // length is the sentinel value (one past the last real type)
        expect(InstrumentType.length).toBe(13); // 12 existing + sampleTrigger
    });
});
