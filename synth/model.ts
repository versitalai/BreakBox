// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: util.ts + format.ts (serialization helpers); dsp.ts (Synth statics, circular); editor/core/EditorConfig; global/Events

import { startLoadingSample, sampleLoadingState, SampleLoadingState, sampleLoadEvents, SampleLoadedEvent, SampleLoadingStatus, loadBuiltInSamples, Dictionary, DictionaryArray, toNameMap, FilterType, SustainType, EnvelopeType, InstrumentType, EffectType, Transition, Unison, Chord, Vibrato, Envelope, AutomationTarget, Config, getDrumWave, drawNoiseSpectrum, performIntegralOld, effectsIncludeTransition, effectsIncludeChord, effectsIncludePitchShift, effectsIncludeDetune, effectsIncludeVibrato, effectsIncludeNoteFilter, effectsIncludeDistortion, effectsIncludeBitcrusher, effectsIncludePanning, effectsIncludeChorus, effectsIncludeEcho, effectsIncludeReverb, effectsIncludeNoteRange, effectsIncludeRingModulation, effectsIncludeGranular, LFOEnvelopeTypes, RandomEnvelopeTypes, effectsIncludePhaser, effectsIncludeInvertWave } from "./SynthConfig";
import { Preset, EditorConfig } from "../editor/core/EditorConfig";
import { scaleElementsByFactor, inverseRealFourierTransform } from "./FFT";
import { FilterCoefficients, FrequencyResponse } from "./filtering";
import { updateFromJukeBox3, updateFromJukeBox4, updateFromUltraBox } from "./PresetUpdates";
import { clamp, parseFloatWithDefault, parseIntWithDefault, validateRange, encode32BitNumber, decode32BitNumber, encodeUnisonSettings, convertLegacyKeyToKeyAndOctave } from "./util";
import { CharCode, SongTagCode, base64IntToCharCode, base64CharCodeToInt, BitFieldReader, BitFieldWriter } from "./format";
import { Synth } from "./dsp";

export interface NotePin {
    interval: number;
    time: number;
    size: number;
}

export function makeNotePin(interval: number, time: number, size: number): NotePin {
    return { interval: interval, time: time, size: size };
}

export class Note {
    public pitches: number[];
    public pins: NotePin[];
    public start: number;
    public end: number;
    public continuesLastPattern: boolean;
    public noteId: number = -1; // Unique ID within pattern for individual note control
    public layer: number = 0; // Overlap layer (0 = base, 1+ = overlapping notes)

    public constructor(pitch: number, start: number, end: number, size: number, fadeout: boolean = false, noteId: number = -1, layer: number = 0) {
        this.pitches = [pitch];
        this.pins = [makeNotePin(0, 0, size), makeNotePin(0, end - start, fadeout ? 0 : size)];
        this.start = start;
        this.end = end;
        this.continuesLastPattern = false;
        this.noteId = noteId;
        this.layer = layer;
    }

    public pickMainInterval(): number {
        let longestFlatIntervalDuration: number = 0;
        let mainInterval: number = 0;
        for (let pinIndex: number = 1; pinIndex < this.pins.length; pinIndex++) {
            const pinA: NotePin = this.pins[pinIndex - 1];
            const pinB: NotePin = this.pins[pinIndex];
            if (pinA.interval == pinB.interval) {
                const duration: number = pinB.time - pinA.time;
                if (longestFlatIntervalDuration < duration) {
                    longestFlatIntervalDuration = duration;
                    mainInterval = pinA.interval;
                }
            }
        }
        if (longestFlatIntervalDuration == 0) {
            let loudestSize: number = 0;
            for (let pinIndex: number = 0; pinIndex < this.pins.length; pinIndex++) {
                const pin: NotePin = this.pins[pinIndex];
                if (loudestSize < pin.size) {
                    loudestSize = pin.size;
                    mainInterval = pin.interval;
                }
            }
        }
        return mainInterval;
    }

    public clone(cloneId: boolean = false): Note {
        const newNote: Note = new Note(-1, this.start, this.end, 3, false, cloneId ? this.noteId : -1, this.layer);
        newNote.pitches = this.pitches.concat();
        newNote.pins = [];
        for (const pin of this.pins) {
            newNote.pins.push(makeNotePin(pin.interval, pin.time, pin.size));
        }
        newNote.continuesLastPattern = this.continuesLastPattern;
        return newNote;
    }

    public getEndPinIndex(part: number): number {
        let endPinIndex: number;
        for (endPinIndex = 1; endPinIndex < this.pins.length - 1; endPinIndex++) {
            if (this.pins[endPinIndex].time + this.start > part) break;
        }
        return endPinIndex;
    }
}

export class Pattern {
    public notes: Note[] = [];
    public readonly instruments: number[] = [0];
    public nextNoteId: number = 1; // Auto-incrementing ID for new notes

    public cloneNotes(): Note[] {
        const result: Note[] = [];
        for (const note of this.notes) {
            result.push(note.clone(true));
        }
        return result;
    }

    public assignNoteId(note: Note): number {
        if (note.noteId === -1) {
            note.noteId = this.nextNoteId++;
        }
        return note.noteId;
    }

    public reset(): void {
        this.notes.length = 0;
        this.instruments[0] = 0;
        this.instruments.length = 1;
        this.nextNoteId = 1;
    }

    public toJsonObject(song: Song, channel: Channel, isModChannel: boolean): any {
        const noteArray: Object[] = [];
        for (const note of this.notes) {
            // Only one ins per pattern is enforced in mod channels.
            let instrument: Instrument = channel.instruments[this.instruments[0]];
            let mod: number = Math.max(0, Config.modCount - note.pitches[0] - 1);
            let volumeCap: number = song.getVolumeCapForSetting(isModChannel, instrument.modulators[mod], instrument.modFilterTypes[mod]);
            const pointArray: Object[] = [];
            for (const pin of note.pins) {
                let useVol: number = isModChannel ? Math.round(pin.size) : Math.round(pin.size * 100 / volumeCap);
                pointArray.push({
                    "tick": (pin.time + note.start) * Config.rhythms[song.rhythm].stepsPerBeat / Config.partsPerBeat,
                    "pitchBend": pin.interval,
                    "volume": useVol,
                    "forMod": isModChannel,
                });
            }

            const noteObject: any = {
                "pitches": note.pitches,
                "points": pointArray,
            };
            if (note.noteId !== -1) {
                noteObject["noteId"] = note.noteId;
            }
            if (note.layer !== 0) {
                noteObject["layer"] = note.layer;
            }
            if (note.start == 0) {
                noteObject["continuesLastPattern"] = note.continuesLastPattern;
            }
            noteArray.push(noteObject);
        }

        const patternObject: any = { "notes": noteArray };
        if (song.patternInstruments) {
            patternObject["instruments"] = this.instruments.map(i => i + 1);
        }
        return patternObject;
    }

    public fromJsonObject(patternObject: any, song: Song, channel: Channel, importedPartsPerBeat: number, isNoiseChannel: boolean, isModChannel: boolean, jsonFormat: string = "auto"): void {
        const format: string = jsonFormat.toLowerCase();

        if (song.patternInstruments) {
            if (Array.isArray(patternObject["instruments"])) {
                const instruments: any[] = patternObject["instruments"];
                const instrumentCount: number = clamp(Config.instrumentCountMin, song.getMaxInstrumentsPerPatternForChannel(channel) + 1, instruments.length);
                for (let j: number = 0; j < instrumentCount; j++) {
                    this.instruments[j] = clamp(0, channel.instruments.length, (instruments[j] | 0) - 1);
                }
                this.instruments.length = instrumentCount;
            } else {
                this.instruments[0] = clamp(0, channel.instruments.length, (patternObject["instrument"] | 0) - 1);
                this.instruments.length = 1;
            }
        }

        if (patternObject["notes"] && patternObject["notes"].length > 0) {
            const maxNoteCount: number = Math.min(song.beatsPerBar * Config.partsPerBeat * (isModChannel ? Config.modCount : 1), patternObject["notes"].length >>> 0);

            // TODO: Consider supporting notes specified in any timing order, sorting them and truncating as necessary.
            //let tickClock: number = 0;
            for (let j: number = 0; j < patternObject["notes"].length; j++) {
                if (j >= maxNoteCount) break;

                const noteObject = patternObject["notes"][j];
                if (!noteObject || !noteObject["pitches"] || !(noteObject["pitches"].length >= 1) || !noteObject["points"] || !(noteObject["points"].length >= 2)) {
                    continue;
                }

                const note: Note = new Note(0, 0, 0, 0);
                note.pitches = [];
                note.pins = [];

                for (let k: number = 0; k < noteObject["pitches"].length; k++) {
                    const pitch: number = noteObject["pitches"][k] | 0;
                    if (note.pitches.indexOf(pitch) != -1) continue;
                    note.pitches.push(pitch);
                    if (note.pitches.length >= Config.maxChordSize) break;
                }
                if (note.pitches.length < 1) continue;

                //let noteClock: number = tickClock;
                let startInterval: number = 0;

                let instrument: Instrument = channel.instruments[this.instruments[0]];
                let mod: number = Math.max(0, Config.modCount - note.pitches[0] - 1);

                for (let k: number = 0; k < noteObject["points"].length; k++) {
                    const pointObject: any = noteObject["points"][k];
                    if (pointObject == undefined || pointObject["tick"] == undefined) continue;
                    const interval: number = (pointObject["pitchBend"] == undefined) ? 0 : (pointObject["pitchBend"] | 0);

                    const time: number = Math.round((+pointObject["tick"]) * Config.partsPerBeat / importedPartsPerBeat);

                    // Only one instrument per pattern allowed in mod channels.
                    let volumeCap: number = song.getVolumeCapForSetting(isModChannel, instrument.modulators[mod], instrument.modFilterTypes[mod]);

                    // The strange volume formula used for notes is not needed for mods. Some rounding errors were possible.
                    // A "forMod" signifier was added to new JSON export to detect when the higher precision export was used in a file.
                    let size: number;
                    if (pointObject["volume"] == undefined) {
                        size = volumeCap;
                    } else if (pointObject["forMod"] == undefined) {
                        size = Math.max(0, Math.min(volumeCap, Math.round((pointObject["volume"] | 0) * volumeCap / 100)));
                    }
                    else {
                        size = ((pointObject["forMod"] | 0) > 0) ? Math.round(pointObject["volume"] | 0) : Math.max(0, Math.min(volumeCap, Math.round((pointObject["volume"] | 0) * volumeCap / 100)));
                    }

                    if (time > song.beatsPerBar * Config.partsPerBeat) continue;
                    if (note.pins.length == 0) {
                        //if (time < noteClock) continue;
                        note.start = time;
                        startInterval = interval;
                    } else {
                        //if (time <= noteClock) continue;
                    }
                    //noteClock = time;

                    note.pins.push(makeNotePin(interval - startInterval, time - note.start, size));
                }
                if (note.pins.length < 2) continue;

                note.end = note.pins[note.pins.length - 1].time + note.start;

                const maxPitch: number = isNoiseChannel ? Config.drumCount - 1 : Config.maxPitch;
                let lowestPitch: number = maxPitch;
                let highestPitch: number = 0;
                for (let k: number = 0; k < note.pitches.length; k++) {
                    note.pitches[k] += startInterval;
                    if (note.pitches[k] < 0 || note.pitches[k] > maxPitch) {
                        note.pitches.splice(k, 1);
                        k--;
                    }
                    if (note.pitches[k] < lowestPitch) lowestPitch = note.pitches[k];
                    if (note.pitches[k] > highestPitch) highestPitch = note.pitches[k];
                }
                if (note.pitches.length < 1) continue;

                for (let k: number = 0; k < note.pins.length; k++) {
                    const pin: NotePin = note.pins[k];
                    if (pin.interval + lowestPitch < 0) pin.interval = -lowestPitch;
                    if (pin.interval + highestPitch > maxPitch) pin.interval = maxPitch - highestPitch;
                    if (k >= 2) {
                        if (pin.interval == note.pins[k - 1].interval &&
                            pin.interval == note.pins[k - 2].interval &&
                            pin.size == note.pins[k - 1].size &&
                            pin.size == note.pins[k - 2].size) {
                            note.pins.splice(k - 1, 1);
                            k--;
                        }
                    }
                }

                if (note.start == 0) {
                    note.continuesLastPattern = (noteObject["continuesLastPattern"] === true);
                } else {
                    note.continuesLastPattern = false;
                }

                // Read noteId and layer for individual note control
                if (noteObject["noteId"] !== undefined) {
                    note.noteId = noteObject["noteId"] | 0;
                    if (note.noteId >= this.nextNoteId) {
                        this.nextNoteId = note.noteId + 1;
                    }
                }
                if (noteObject["layer"] !== undefined) {
                    note.layer = noteObject["layer"] | 0;
                }

                if ((format != "ultrabox" && format != "slarmoosbox") && instrument.modulators[mod] == Config.modulators.dictionary["tempo"].index) {
                    for (const pin of note.pins) {
                        const oldMin: number = 30;
                        const newMin: number = 1;
                        const old: number = pin.size + oldMin;
                        pin.size = old - newMin; // convertRealFactor will add back newMin as necessary
                    }
                }

                this.notes.push(note);
            }
        }
    }
}

export class Operator {
    public frequency: number = 4;
    public amplitude: number = 0;
    public waveform: number = 0;
    public pulseWidth: number = 0.5;

    constructor(index: number) {
        this.reset(index);
    }

    public reset(index: number): void {
        this.frequency = 4; //defualt to 1x
        this.amplitude = (index <= 1) ? Config.operatorAmplitudeMax : 0;
        this.waveform = 0;
        this.pulseWidth = 5;
    }

    public copy(other: Operator): void {
        this.frequency = other.frequency;
        this.amplitude = other.amplitude;
        this.waveform = other.waveform;
        this.pulseWidth = other.pulseWidth;
    }
}

export class CustomAlgorithm {
    public name: string = "";
    public carrierCount: number = 0;
    public modulatedBy: number[][] = [[], [], [], [], [], []];
    public associatedCarrier: number[] = [];

    constructor() {
        this.fromPreset(1);
    }

    public set(carriers: number, modulation: number[][]) {
        this.reset();
        this.carrierCount = carriers;
        for (let i = 0; i < this.modulatedBy.length; i++) {
            this.modulatedBy[i] = modulation[i];
            if (i < carriers) {
                this.associatedCarrier[i] = i + 1;
            }
            this.name += (i + 1);
            for (let j = 0; j < modulation[i].length; j++) {
                this.name += modulation[i][j];
                if (modulation[i][j] > carriers - 1) {
                    this.associatedCarrier[modulation[i][j] - 1] = i + 1;
                }
                this.name += ",";
            }
            if (i < carriers) {
                this.name += "|";
            } else {
                this.name += ".";
            }
        }
    }

    public reset(): void {
        this.name = ""
        this.carrierCount = 1;
        this.modulatedBy = [[2, 3, 4, 5, 6], [], [], [], [], []];
        this.associatedCarrier = [1, 1, 1, 1, 1, 1];
    }

    public copy(other: CustomAlgorithm): void {
        this.name = other.name;
        this.carrierCount = other.carrierCount;
        this.modulatedBy = other.modulatedBy;
        this.associatedCarrier = other.associatedCarrier;
    }

    public fromPreset(other: number): void {
        this.reset();
        let preset = Config.algorithms6Op[other]
        this.name = preset.name;
        this.carrierCount = preset.carrierCount;
        for (var i = 0; i < preset.modulatedBy.length; i++) {
            this.modulatedBy[i] = Array.from(preset.modulatedBy[i]);
            this.associatedCarrier[i] = preset.associatedCarrier[i];
        }
    }
}

export class CustomFeedBack { //feels redunant
    public name: string = "";
    public indices: number[][] = [[], [], [], [], [], []];

    constructor() {
        this.fromPreset(1);
    }

    public set(inIndices: number[][]) {
        this.reset();
        for (let i = 0; i < this.indices.length; i++) {
            this.indices[i] = inIndices[i];
            for (let j = 0; j < inIndices[i].length; j++) {
                this.name += inIndices[i][j];
                this.name += ",";
            }
            this.name += ".";
        }
    }

    public reset(): void {
        this.reset;
        this.name = "";
        this.indices = [[1], [], [], [], [], []];
    }

    public copy(other: CustomFeedBack): void {
        this.name = other.name;
        this.indices = other.indices;
    }

    public fromPreset(other: number): void {
        this.reset();
        let preset = Config.feedbacks6Op[other]
        for (var i = 0; i < preset.indices.length; i++) {
            this.indices[i] = Array.from(preset.indices[i]);
            for (let j = 0; j < preset.indices[i].length; j++) {
                this.name += preset.indices[i][j];
                this.name += ",";
            }
            this.name += ".";
        }
    }
}

export class SpectrumWave {
    public spectrum: number[] = [];
    public hash: number = -1;

    constructor(isNoiseChannel: boolean) {
        this.reset(isNoiseChannel);
    }

    public reset(isNoiseChannel: boolean): void {
        for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
            if (isNoiseChannel) {
                this.spectrum[i] = Math.round(Config.spectrumMax * (1 / Math.sqrt(1 + i / 3)));
            } else {
                const isHarmonic: boolean = i == 0 || i == 7 || i == 11 || i == 14 || i == 16 || i == 18 || i == 21 || i == 23 || i >= 25;
                this.spectrum[i] = isHarmonic ? Math.max(0, Math.round(Config.spectrumMax * (1 - i / 30))) : 0;
            }
        }
        this.markCustomWaveDirty();
    }

    public markCustomWaveDirty(): void {
        const hashMult: number = Synth.fittingPowerOfTwo(Config.spectrumMax + 2) - 1;
        let hash: number = 0;
        for (const point of this.spectrum) hash = ((hash * hashMult) + point) >>> 0;
        this.hash = hash;
    }
}

export class SpectrumWaveState {
    public wave: Float32Array | null = null;
    private _hash: number = -1;

    public getCustomWave(settings: SpectrumWave, lowestOctave: number): Float32Array {
        if (this._hash == settings.hash) return this.wave!;
        this._hash = settings.hash;

        const waveLength: number = Config.spectrumNoiseLength;
        if (this.wave == null || this.wave.length != waveLength + 1) {
            this.wave = new Float32Array(waveLength + 1);
        }
        const wave: Float32Array = this.wave;

        for (let i: number = 0; i < waveLength; i++) {
            wave[i] = 0;
        }

        const highestOctave: number = 14;
        const falloffRatio: number = 0.25;
        // Nudge the 2/7 and 4/7 control points so that they form harmonic intervals.
        const pitchTweak: number[] = [0, 1 / 7, Math.log2(5 / 4), 3 / 7, Math.log2(3 / 2), 5 / 7, 6 / 7];
        function controlPointToOctave(point: number): number {
            return lowestOctave + Math.floor(point / Config.spectrumControlPointsPerOctave) + pitchTweak[(point + Config.spectrumControlPointsPerOctave) % Config.spectrumControlPointsPerOctave];
        }

        let combinedAmplitude: number = 1;
        for (let i: number = 0; i < Config.spectrumControlPoints + 1; i++) {
            const value1: number = (i <= 0) ? 0 : settings.spectrum[i - 1];
            const value2: number = (i >= Config.spectrumControlPoints) ? settings.spectrum[Config.spectrumControlPoints - 1] : settings.spectrum[i];
            const octave1: number = controlPointToOctave(i - 1);
            let octave2: number = controlPointToOctave(i);
            if (i >= Config.spectrumControlPoints) octave2 = highestOctave + (octave2 - highestOctave) * falloffRatio;
            if (value1 == 0 && value2 == 0) continue;

            combinedAmplitude += 0.02 * drawNoiseSpectrum(wave, waveLength, octave1, octave2, value1 / Config.spectrumMax, value2 / Config.spectrumMax, -0.5);
        }
        if (settings.spectrum[Config.spectrumControlPoints - 1] > 0) {
            combinedAmplitude += 0.02 * drawNoiseSpectrum(wave, waveLength, highestOctave + (controlPointToOctave(Config.spectrumControlPoints) - highestOctave) * falloffRatio, highestOctave, settings.spectrum[Config.spectrumControlPoints - 1] / Config.spectrumMax, 0, -0.5);
        }

        inverseRealFourierTransform(wave, waveLength);
        scaleElementsByFactor(wave, 5.0 / (Math.sqrt(waveLength) * Math.pow(combinedAmplitude, 0.75)));

        // Duplicate the first sample at the end for easier wrap-around interpolation.
        wave[waveLength] = wave[0];

        return wave;
    }
}

export class HarmonicsWave {
    public harmonics: number[] = [];
    public hash: number = -1;

    constructor() {
        this.reset();
    }

    public reset(): void {
        for (let i: number = 0; i < Config.harmonicsControlPoints; i++) {
            this.harmonics[i] = 0;
        }
        this.harmonics[0] = Config.harmonicsMax;
        this.harmonics[3] = Config.harmonicsMax;
        this.harmonics[6] = Config.harmonicsMax;
        this.markCustomWaveDirty();
    }

    public markCustomWaveDirty(): void {
        const hashMult: number = Synth.fittingPowerOfTwo(Config.harmonicsMax + 2) - 1;
        let hash: number = 0;
        for (const point of this.harmonics) hash = ((hash * hashMult) + point) >>> 0;
        this.hash = hash;
    }
}

export class HarmonicsWaveState {
    public wave: Float32Array | null = null;
    private _hash: number = -1;
    private _generatedForType: InstrumentType;

    public getCustomWave(settings: HarmonicsWave, instrumentType: InstrumentType): Float32Array {
        if (this._hash == settings.hash && this._generatedForType == instrumentType) return this.wave!;
        this._hash = settings.hash;
        this._generatedForType = instrumentType;

        const harmonicsRendered: number = (instrumentType == InstrumentType.pickedString) ? Config.harmonicsRenderedForPickedString : Config.harmonicsRendered;

        const waveLength: number = Config.harmonicsWavelength;
        const retroWave: Float32Array = getDrumWave(0, null, null);

        if (this.wave == null || this.wave.length != waveLength + 1) {
            this.wave = new Float32Array(waveLength + 1);
        }
        const wave: Float32Array = this.wave;

        for (let i: number = 0; i < waveLength; i++) {
            wave[i] = 0;
        }

        const overallSlope: number = -0.25;
        let combinedControlPointAmplitude: number = 1;

        for (let harmonicIndex: number = 0; harmonicIndex < harmonicsRendered; harmonicIndex++) {
            const harmonicFreq: number = harmonicIndex + 1;
            let controlValue: number = harmonicIndex < Config.harmonicsControlPoints ? settings.harmonics[harmonicIndex] : settings.harmonics[Config.harmonicsControlPoints - 1];
            if (harmonicIndex >= Config.harmonicsControlPoints) {
                controlValue *= 1 - (harmonicIndex - Config.harmonicsControlPoints) / (harmonicsRendered - Config.harmonicsControlPoints);
            }
            const normalizedValue: number = controlValue / Config.harmonicsMax;
            let amplitude: number = Math.pow(2, controlValue - Config.harmonicsMax + 1) * Math.sqrt(normalizedValue);
            if (harmonicIndex < Config.harmonicsControlPoints) {
                combinedControlPointAmplitude += amplitude;
            }
            amplitude *= Math.pow(harmonicFreq, overallSlope);

            // Multiply all the sine wave amplitudes by 1 or -1 based on the LFSR
            // retro wave (effectively random) to avoid egregiously tall spikes.
            amplitude *= retroWave[harmonicIndex + 589];

            wave[waveLength - harmonicFreq] = amplitude;
        }

        inverseRealFourierTransform(wave, waveLength);

        // Limit the maximum wave amplitude.
        const mult: number = 1 / Math.pow(combinedControlPointAmplitude, 0.7);
        for (let i: number = 0; i < wave.length; i++) wave[i] *= mult;

        performIntegralOld(wave);

        // The first sample should be zero, and we'll duplicate it at the end for easier interpolation.
        wave[waveLength] = wave[0];

        return wave;
    }
}

export class Grain {
    public delayLinePosition: number; // Relative to latest sample

    public ageInSamples: number;
    public maxAgeInSamples: number;
    public delay: number;

    //parabolic envelope implementation
    public parabolicEnvelopeAmplitude: number;
    public parabolicEnvelopeSlope: number;
    public parabolicEnvelopeCurve: number;

    //raised cosine bell envelope implementation
    public rcbEnvelopeAmplitude: number;
    public rcbEnvelopeAttackIndex: number;
    public rcbEnvelopeReleaseIndex: number;
    public rcbEnvelopeSustain: number;

    constructor() {
        this.delayLinePosition = 0;

        this.ageInSamples = 0;
        this.maxAgeInSamples = 0;
        this.delay = 0;

        this.parabolicEnvelopeAmplitude = 0;
        this.parabolicEnvelopeSlope = 0;
        this.parabolicEnvelopeCurve = 0;

        this.rcbEnvelopeAmplitude = 0;
        this.rcbEnvelopeAttackIndex = 0;
        this.rcbEnvelopeReleaseIndex = 0;
        this.rcbEnvelopeSustain = 0;
    }

    public initializeParabolicEnvelope(durationInSamples: number, amplitude: number): void {
        this.parabolicEnvelopeAmplitude = 0;
        if (durationInSamples == 0) durationInSamples++; //prevent division by 0
        const invDuration: number = 1.0 / durationInSamples;
        const invDurationSquared: number = invDuration * invDuration;
        this.parabolicEnvelopeSlope = 4.0 * amplitude * (invDuration - invDurationSquared);
        this.parabolicEnvelopeCurve = -8.0 * amplitude * invDurationSquared;
    }

    public updateParabolicEnvelope(): void {
        this.parabolicEnvelopeAmplitude += this.parabolicEnvelopeSlope;
        this.parabolicEnvelopeSlope += this.parabolicEnvelopeCurve;
    }

    //rcb is unfinished and unused rn
    public initializeRCBEnvelope(durationInSamples: number, amplitude: number): void {
        // attack:
        this.rcbEnvelopeAttackIndex = Math.floor(durationInSamples / 6);
        // sustain:
        this.rcbEnvelopeSustain = amplitude;
        // release:
        this.rcbEnvelopeReleaseIndex = Math.floor(durationInSamples * 5 / 6);
    }

    public updateRCBEnvelope(): void {
        if (this.ageInSamples < this.rcbEnvelopeAttackIndex) { //attack
            this.rcbEnvelopeAmplitude = (1.0 + Math.cos(Math.PI + (Math.PI * (this.ageInSamples / this.rcbEnvelopeAttackIndex) * (this.rcbEnvelopeSustain / 2.0))));
        } else if (this.ageInSamples > this.rcbEnvelopeReleaseIndex) { //release
            this.rcbEnvelopeAmplitude = (1.0 + Math.cos(Math.PI * ((this.ageInSamples - this.rcbEnvelopeReleaseIndex) / this.rcbEnvelopeAttackIndex)) * (this.rcbEnvelopeSustain / 2.0));
        } //sustain covered by the end of attack
    }

    public addDelay(delay: number): void {
        this.delay = delay;
    }
}

export class FilterControlPoint {
    public freq: number = 0;
    public gain: number = Config.filterGainCenter;
    public type: FilterType = FilterType.peak;

    public set(freqSetting: number, gainSetting: number): void {
        this.freq = freqSetting;
        this.gain = gainSetting;
    }

    public getHz(): number {
        return FilterControlPoint.getHzFromSettingValue(this.freq);
    }

    public static getHzFromSettingValue(value: number): number {
        return Config.filterFreqReferenceHz * Math.pow(2.0, (value - Config.filterFreqReferenceSetting) * Config.filterFreqStep);
    }
    public static getSettingValueFromHz(hz: number): number {
        return Math.log2(hz / Config.filterFreqReferenceHz) / Config.filterFreqStep + Config.filterFreqReferenceSetting;
    }
    public static getRoundedSettingValueFromHz(hz: number): number {
        return Math.max(0, Math.min(Config.filterFreqRange - 1, Math.round(FilterControlPoint.getSettingValueFromHz(hz))));
    }

    public getLinearGain(peakMult: number = 1.0): number {
        const power: number = (this.gain - Config.filterGainCenter) * Config.filterGainStep;
        const neutral: number = (this.type == FilterType.peak) ? 0.0 : -0.5;
        const interpolatedPower: number = neutral + (power - neutral) * peakMult;
        return Math.pow(2.0, interpolatedPower);
    }
    public static getRoundedSettingValueFromLinearGain(linearGain: number): number {
        return Math.max(0, Math.min(Config.filterGainRange - 1, Math.round(Math.log2(linearGain) / Config.filterGainStep + Config.filterGainCenter)));
    }

    public toCoefficients(filter: FilterCoefficients, sampleRate: number, freqMult: number = 1.0, peakMult: number = 1.0): void {
        const cornerRadiansPerSample: number = 2.0 * Math.PI * Math.max(Config.filterFreqMinHz, Math.min(Config.filterFreqMaxHz, freqMult * this.getHz())) / sampleRate;
        const linearGain: number = this.getLinearGain(peakMult);
        switch (this.type) {
            case FilterType.lowPass:
                filter.lowPass2ndOrderButterworth(cornerRadiansPerSample, linearGain);
                break;
            case FilterType.highPass:
                filter.highPass2ndOrderButterworth(cornerRadiansPerSample, linearGain);
                break;
            case FilterType.peak:
                filter.peak2ndOrder(cornerRadiansPerSample, linearGain, 1.0);
                break;
            default:
                throw new Error();
        }
    }

    public getVolumeCompensationMult(): number {
        const octave: number = (this.freq - Config.filterFreqReferenceSetting) * Config.filterFreqStep;
        const gainPow: number = (this.gain - Config.filterGainCenter) * Config.filterGainStep;
        switch (this.type) {
            case FilterType.lowPass:
                const freqRelativeTo8khz: number = Math.pow(2.0, octave) * Config.filterFreqReferenceHz / 8000.0;
                // Reverse the frequency warping from importing legacy simplified filters to imitate how the legacy filter cutoff setting affected volume.
                const warpedFreq: number = (Math.sqrt(1.0 + 4.0 * freqRelativeTo8khz) - 1.0) / 2.0;
                const warpedOctave: number = Math.log2(warpedFreq);
                return Math.pow(0.5, 0.2 * Math.max(0.0, gainPow + 1.0) + Math.min(0.0, Math.max(-3.0, 0.595 * warpedOctave + 0.35 * Math.min(0.0, gainPow + 1.0))));
            case FilterType.highPass:
                return Math.pow(0.5, 0.125 * Math.max(0.0, gainPow + 1.0) + Math.min(0.0, 0.3 * (-octave - Math.log2(Config.filterFreqReferenceHz / 125.0)) + 0.2 * Math.min(0.0, gainPow + 1.0)));
            case FilterType.peak:
                const distanceFromCenter: number = octave + Math.log2(Config.filterFreqReferenceHz / 2000.0);
                const freqLoudness: number = Math.pow(1.0 / (1.0 + Math.pow(distanceFromCenter / 3.0, 2.0)), 2.0);
                return Math.pow(0.5, 0.125 * Math.max(0.0, gainPow) + 0.1 * freqLoudness * Math.min(0.0, gainPow));
            default:
                throw new Error();
        }
    }
}

export class FilterSettings {
    public readonly controlPoints: FilterControlPoint[] = [];
    public controlPointCount: number = 0;

    constructor() {
        this.reset();
    }

    reset(): void {
        this.controlPointCount = 0;
    }

    addPoint(type: FilterType, freqSetting: number, gainSetting: number): void {
        let controlPoint: FilterControlPoint;
        if (this.controlPoints.length <= this.controlPointCount) {
            controlPoint = new FilterControlPoint();
            this.controlPoints[this.controlPointCount] = controlPoint;
        } else {
            controlPoint = this.controlPoints[this.controlPointCount];
        }
        this.controlPointCount++;
        controlPoint.type = type;
        controlPoint.set(freqSetting, gainSetting);
    }

    public toJsonObject(): Object {
        const filterArray: any[] = [];
        for (let i: number = 0; i < this.controlPointCount; i++) {
            const point: FilterControlPoint = this.controlPoints[i];
            filterArray.push({
                "type": Config.filterTypeNames[point.type],
                "cutoffHz": Math.round(point.getHz() * 100) / 100,
                "linearGain": Math.round(point.getLinearGain() * 10000) / 10000,
            });
        }
        return filterArray;
    }

    public fromJsonObject(filterObject: any): void {
        this.controlPoints.length = 0;
        if (filterObject) {
            for (const pointObject of filterObject) {
                const point: FilterControlPoint = new FilterControlPoint();
                point.type = Config.filterTypeNames.indexOf(pointObject["type"]);
                if (<any>point.type == -1) point.type = FilterType.peak;
                if (pointObject["cutoffHz"] != undefined) {
                    point.freq = FilterControlPoint.getRoundedSettingValueFromHz(pointObject["cutoffHz"]);
                } else {
                    point.freq = 0;
                }
                if (pointObject["linearGain"] != undefined) {
                    point.gain = FilterControlPoint.getRoundedSettingValueFromLinearGain(pointObject["linearGain"]);
                } else {
                    point.gain = Config.filterGainCenter;
                }
                this.controlPoints.push(point);
            }
        }
        this.controlPointCount = this.controlPoints.length;
    }

    // Returns true if all filter control points match in number and type (but not freq/gain)
    public static filtersCanMorph(filterA: FilterSettings, filterB: FilterSettings): boolean {
        if (filterA.controlPointCount != filterB.controlPointCount)
            return false;
        for (let i: number = 0; i < filterA.controlPointCount; i++) {
            if (filterA.controlPoints[i].type != filterB.controlPoints[i].type)
                return false;
        }
        return true;
    }

    // Interpolate two FilterSettings, where pos=0 is filterA and pos=1 is filterB
    public static lerpFilters(filterA: FilterSettings, filterB: FilterSettings, pos: number): FilterSettings {

        let lerpedFilter: FilterSettings = new FilterSettings();

        // One setting or another is null, return the other.
        if (filterA == null) {
            return filterA;
        }
        if (filterB == null) {
            return filterB;
        }

        pos = Math.max(0, Math.min(1, pos));

        // Filter control points match in number and type
        if (this.filtersCanMorph(filterA, filterB)) {
            for (let i: number = 0; i < filterA.controlPointCount; i++) {
                lerpedFilter.controlPoints[i] = new FilterControlPoint();
                lerpedFilter.controlPoints[i].type = filterA.controlPoints[i].type;
                lerpedFilter.controlPoints[i].freq = filterA.controlPoints[i].freq + (filterB.controlPoints[i].freq - filterA.controlPoints[i].freq) * pos;
                lerpedFilter.controlPoints[i].gain = filterA.controlPoints[i].gain + (filterB.controlPoints[i].gain - filterA.controlPoints[i].gain) * pos;
            }

            lerpedFilter.controlPointCount = filterA.controlPointCount;

            return lerpedFilter;
        }
        else {
            // Not allowing morph of unmatching filters for now. It's a hornet's nest of problems, and I had it implemented and mostly working and it didn't sound very interesting since the shape becomes "mushy" in between
            return (pos >= 1) ? filterB : filterA;
        }
    }

    public convertLegacySettings(legacyCutoffSetting: number, legacyResonanceSetting: number, legacyEnv: Envelope): void {
        this.reset();

        const legacyFilterCutoffMaxHz: number = 8000; // This was carefully calculated to correspond to no change in response when filtering at 48000 samples per second... when using the legacy simplified low-pass filter.
        const legacyFilterMax: number = 0.95;
        const legacyFilterMaxRadians: number = Math.asin(legacyFilterMax / 2.0) * 2.0;
        const legacyFilterMaxResonance: number = 0.95;
        const legacyFilterCutoffRange: number = 11;
        const legacyFilterResonanceRange: number = 8;

        const resonant: boolean = (legacyResonanceSetting > 1);
        const firstOrder: boolean = (legacyResonanceSetting == 0);
        const cutoffAtMax: boolean = (legacyCutoffSetting == legacyFilterCutoffRange - 1);
        const envDecays: boolean = (legacyEnv.type == EnvelopeType.flare || legacyEnv.type == EnvelopeType.twang || legacyEnv.type == EnvelopeType.decay || legacyEnv.type == EnvelopeType.noteSize);

        const standardSampleRate: number = 48000;
        const legacyHz: number = legacyFilterCutoffMaxHz * Math.pow(2.0, (legacyCutoffSetting - (legacyFilterCutoffRange - 1)) * 0.5);
        const legacyRadians: number = Math.min(legacyFilterMaxRadians, 2 * Math.PI * legacyHz / standardSampleRate);

        if (legacyEnv.type == EnvelopeType.none && !resonant && cutoffAtMax) {
            // The response is flat and there's no envelopes, so don't even bother adding any control points.
        } else if (firstOrder) {
            // In general, a 1st order lowpass can be approximated by a 2nd order lowpass
            // with a cutoff ~4 octaves higher (*16) and a gain of 1/16.
            // However, BeepBox's original lowpass filters behaved oddly as they
            // approach the nyquist frequency, so I've devised this curved conversion
            // to guess at a perceptually appropriate new cutoff frequency and gain.
            const extraOctaves: number = 3.5;
            const targetRadians: number = legacyRadians * Math.pow(2.0, extraOctaves);
            const curvedRadians: number = targetRadians / (1.0 + targetRadians / Math.PI);
            const curvedHz: number = standardSampleRate * curvedRadians / (2.0 * Math.PI)
            const freqSetting: number = FilterControlPoint.getRoundedSettingValueFromHz(curvedHz);
            const finalHz: number = FilterControlPoint.getHzFromSettingValue(freqSetting);
            const finalRadians: number = 2.0 * Math.PI * finalHz / standardSampleRate;

            const legacyFilter: FilterCoefficients = new FilterCoefficients();
            legacyFilter.lowPass1stOrderSimplified(legacyRadians);
            const response: FrequencyResponse = new FrequencyResponse();
            response.analyze(legacyFilter, finalRadians);
            const legacyFilterGainAtNewRadians: number = response.magnitude();

            let logGain: number = Math.log2(legacyFilterGainAtNewRadians);
            // Bias slightly toward 2^(-extraOctaves):
            logGain = -extraOctaves + (logGain + extraOctaves) * 0.82;
            // Decaying envelopes move the cutoff frequency back into an area where the best approximation of the first order slope requires a lower gain setting.
            if (envDecays) logGain = Math.min(logGain, -1.0);
            const convertedGain: number = Math.pow(2.0, logGain);
            const gainSetting: number = FilterControlPoint.getRoundedSettingValueFromLinearGain(convertedGain);

            this.addPoint(FilterType.lowPass, freqSetting, gainSetting);
        } else {
            const intendedGain: number = 0.5 / (1.0 - legacyFilterMaxResonance * Math.sqrt(Math.max(0.0, legacyResonanceSetting - 1.0) / (legacyFilterResonanceRange - 2.0)));
            const invertedGain: number = 0.5 / intendedGain;
            const maxRadians: number = 2.0 * Math.PI * legacyFilterCutoffMaxHz / standardSampleRate;
            const freqRatio: number = legacyRadians / maxRadians;
            const targetRadians: number = legacyRadians * (freqRatio * Math.pow(invertedGain, 0.9) + 1.0);
            const curvedRadians: number = legacyRadians + (targetRadians - legacyRadians) * invertedGain;
            let curvedHz: number;
            if (envDecays) {
                curvedHz = standardSampleRate * Math.min(curvedRadians, legacyRadians * Math.pow(2, 0.25)) / (2.0 * Math.PI);
            } else {
                curvedHz = standardSampleRate * curvedRadians / (2.0 * Math.PI);
            }
            const freqSetting: number = FilterControlPoint.getRoundedSettingValueFromHz(curvedHz);

            let legacyFilterGain: number;
            if (envDecays) {
                legacyFilterGain = intendedGain;
            } else {
                const legacyFilter: FilterCoefficients = new FilterCoefficients();
                legacyFilter.lowPass2ndOrderSimplified(legacyRadians, intendedGain);
                const response: FrequencyResponse = new FrequencyResponse();
                response.analyze(legacyFilter, curvedRadians);
                legacyFilterGain = response.magnitude();
            }
            if (!resonant) legacyFilterGain = Math.min(legacyFilterGain, Math.sqrt(0.5));
            const gainSetting: number = FilterControlPoint.getRoundedSettingValueFromLinearGain(legacyFilterGain);

            this.addPoint(FilterType.lowPass, freqSetting, gainSetting);
        }

        // Added for JummBox - making a 0 point filter does not truncate control points!
        this.controlPoints.length = this.controlPointCount;
    }

    // Similar to above, but purpose-fit for quick conversions in synth calls.
    public convertLegacySettingsForSynth(legacyCutoffSetting: number, legacyResonanceSetting: number, allowFirstOrder: boolean = false): void {
        this.reset();

        const legacyFilterCutoffMaxHz: number = 8000; // This was carefully calculated to correspond to no change in response when filtering at 48000 samples per second... when using the legacy simplified low-pass filter.
        const legacyFilterMax: number = 0.95;
        const legacyFilterMaxRadians: number = Math.asin(legacyFilterMax / 2.0) * 2.0;
        const legacyFilterMaxResonance: number = 0.95;
        const legacyFilterCutoffRange: number = 11;
        const legacyFilterResonanceRange: number = 8;

        const firstOrder: boolean = (legacyResonanceSetting == 0 && allowFirstOrder);
        const standardSampleRate: number = 48000;
        const legacyHz: number = legacyFilterCutoffMaxHz * Math.pow(2.0, (legacyCutoffSetting - (legacyFilterCutoffRange - 1)) * 0.5);
        const legacyRadians: number = Math.min(legacyFilterMaxRadians, 2 * Math.PI * legacyHz / standardSampleRate);

        if (firstOrder) {
            // In general, a 1st order lowpass can be approximated by a 2nd order lowpass
            // with a cutoff ~4 octaves higher (*16) and a gain of 1/16.
            // However, BeepBox's original lowpass filters behaved oddly as they
            // approach the nyquist frequency, so I've devised this curved conversion
            // to guess at a perceptually appropriate new cutoff frequency and gain.
            const extraOctaves: number = 3.5;
            const targetRadians: number = legacyRadians * Math.pow(2.0, extraOctaves);
            const curvedRadians: number = targetRadians / (1.0 + targetRadians / Math.PI);
            const curvedHz: number = standardSampleRate * curvedRadians / (2.0 * Math.PI)
            const freqSetting: number = FilterControlPoint.getRoundedSettingValueFromHz(curvedHz);
            const finalHz: number = FilterControlPoint.getHzFromSettingValue(freqSetting);
            const finalRadians: number = 2.0 * Math.PI * finalHz / standardSampleRate;

            const legacyFilter: FilterCoefficients = new FilterCoefficients();
            legacyFilter.lowPass1stOrderSimplified(legacyRadians);
            const response: FrequencyResponse = new FrequencyResponse();
            response.analyze(legacyFilter, finalRadians);
            const legacyFilterGainAtNewRadians: number = response.magnitude();

            let logGain: number = Math.log2(legacyFilterGainAtNewRadians);
            // Bias slightly toward 2^(-extraOctaves):
            logGain = -extraOctaves + (logGain + extraOctaves) * 0.82;
            const convertedGain: number = Math.pow(2.0, logGain);
            const gainSetting: number = FilterControlPoint.getRoundedSettingValueFromLinearGain(convertedGain);

            this.addPoint(FilterType.lowPass, freqSetting, gainSetting);
        } else {
            const intendedGain: number = 0.5 / (1.0 - legacyFilterMaxResonance * Math.sqrt(Math.max(0.0, legacyResonanceSetting - 1.0) / (legacyFilterResonanceRange - 2.0)));
            const invertedGain: number = 0.5 / intendedGain;
            const maxRadians: number = 2.0 * Math.PI * legacyFilterCutoffMaxHz / standardSampleRate;
            const freqRatio: number = legacyRadians / maxRadians;
            const targetRadians: number = legacyRadians * (freqRatio * Math.pow(invertedGain, 0.9) + 1.0);
            const curvedRadians: number = legacyRadians + (targetRadians - legacyRadians) * invertedGain;
            let curvedHz: number;

            curvedHz = standardSampleRate * curvedRadians / (2.0 * Math.PI);
            const freqSetting: number = FilterControlPoint.getSettingValueFromHz(curvedHz);

            let legacyFilterGain: number;

            const legacyFilter: FilterCoefficients = new FilterCoefficients();
            legacyFilter.lowPass2ndOrderSimplified(legacyRadians, intendedGain);
            const response: FrequencyResponse = new FrequencyResponse();
            response.analyze(legacyFilter, curvedRadians);
            legacyFilterGain = response.magnitude();
            const gainSetting: number = FilterControlPoint.getRoundedSettingValueFromLinearGain(legacyFilterGain);

            this.addPoint(FilterType.lowPass, freqSetting, gainSetting);
        }

    }
}

export class EnvelopeSettings {
    public target: number = 0;
    public index: number = 0;
    public envelope: number = 0;
    //slarmoo's box 1.0
    public pitchEnvelopeStart: number;
    public pitchEnvelopeEnd: number;
    public inverse: boolean;
    //midbox
    public perEnvelopeSpeed: number = Config.envelopes[this.envelope].speed;
    public perEnvelopeLowerBound: number = 0;
    public perEnvelopeUpperBound: number = 1;
    //modulation support
    public tempEnvelopeSpeed: number | null = null;
    public tempEnvelopeLowerBound: number | null = null;
    public tempEnvelopeUpperBound: number | null = null;
    //pseudo random
    public steps: number = 2;
    public seed: number = 2;
    //lfo and random types
    public waveform: number = LFOEnvelopeTypes.sine;
    //moved discrete into here
    public discrete: boolean = false;

    constructor(public isNoiseEnvelope: boolean) {
        this.reset();
    }

    reset(): void {
        this.target = 0;
        this.index = 0;
        this.envelope = 0;
        this.pitchEnvelopeStart = 0;
        this.pitchEnvelopeEnd = this.isNoiseEnvelope ? Config.drumCount - 1 : Config.maxPitch;
        this.inverse = false;
        this.isNoiseEnvelope = false;
        this.perEnvelopeSpeed = Config.envelopes[this.envelope].speed;
        this.perEnvelopeLowerBound = 0;
        this.perEnvelopeUpperBound = 1;
        this.tempEnvelopeSpeed = null;
        this.tempEnvelopeLowerBound = null;
        this.tempEnvelopeUpperBound = null;
        this.steps = 2;
        this.seed = 2;
        this.waveform = LFOEnvelopeTypes.sine;
        this.discrete = false;
    }

    public toJsonObject(): Object {
        const envelopeObject: any = {
            "target": Config.instrumentAutomationTargets[this.target].name,
            "envelope": Config.newEnvelopes[this.envelope].name,
            "inverse": this.inverse,
            "perEnvelopeSpeed": this.perEnvelopeSpeed,
            "perEnvelopeLowerBound": this.perEnvelopeLowerBound,
            "perEnvelopeUpperBound": this.perEnvelopeUpperBound,
            "discrete": this.discrete,
        };
        if (Config.instrumentAutomationTargets[this.target].maxCount > 1) {
            envelopeObject["index"] = this.index;
        }
        if (Config.newEnvelopes[this.envelope].name == "pitch") {
            envelopeObject["pitchEnvelopeStart"] = this.pitchEnvelopeStart;
            envelopeObject["pitchEnvelopeEnd"] = this.pitchEnvelopeEnd;
        } else if (Config.newEnvelopes[this.envelope].name == "random") {
            envelopeObject["steps"] = this.steps;
            envelopeObject["seed"] = this.seed;
            envelopeObject["waveform"] = this.waveform;
        } else if (Config.newEnvelopes[this.envelope].name == "lfo") {
            envelopeObject["waveform"] = this.waveform;
            envelopeObject["steps"] = this.steps;
        }
        return envelopeObject;
    }

    public fromJsonObject(envelopeObject: any, format: string): void {
        this.reset();

        let target: AutomationTarget = Config.instrumentAutomationTargets.dictionary[envelopeObject["target"]];
        if (target == null) target = Config.instrumentAutomationTargets.dictionary["noteVolume"];
        this.target = target.index;

        let envelope: Envelope = Config.envelopes.dictionary["none"];
        let isTremolo2: Boolean = false;
        if (format == "slarmoosbox") {
            if (envelopeObject["envelope"] == "tremolo2") {
                envelope = Config.newEnvelopes[EnvelopeType.lfo];
                isTremolo2 = true;
            } else if (envelopeObject["envelope"] == "tremolo") {
                envelope = Config.newEnvelopes[EnvelopeType.lfo];
                isTremolo2 = false;
            } else {
                envelope = Config.newEnvelopes.dictionary[envelopeObject["envelope"]];
            }
        } else {
            if (Config.envelopes.dictionary[envelopeObject["envelope"]].type == EnvelopeType.tremolo2) {
                envelope = Config.newEnvelopes[EnvelopeType.lfo];
                isTremolo2 = true;
            } else if (Config.newEnvelopes[Math.max(Config.envelopes.dictionary[envelopeObject["envelope"]].type - 1, 0)].index > EnvelopeType.lfo) {
                envelope = Config.newEnvelopes[Config.envelopes.dictionary[envelopeObject["envelope"]].type - 1];
            } else {
                envelope = Config.newEnvelopes[Config.envelopes.dictionary[envelopeObject["envelope"]].type];
            }
        }

        if (envelope == undefined) {
            if (Config.envelopes.dictionary[envelopeObject["envelope"]].type == EnvelopeType.tremolo2) {
                envelope = Config.newEnvelopes[EnvelopeType.lfo];
                isTremolo2 = true;
            } else if (Config.newEnvelopes[Math.max(Config.envelopes.dictionary[envelopeObject["envelope"]].type - 1, 0)].index > EnvelopeType.lfo) {
                envelope = Config.newEnvelopes[Config.envelopes.dictionary[envelopeObject["envelope"]].type - 1];
            } else {
                envelope = Config.newEnvelopes[Config.envelopes.dictionary[envelopeObject["envelope"]].type];
            }
        }
        if (envelope == null) envelope = Config.envelopes.dictionary["none"];
        this.envelope = envelope.index;

        if (envelopeObject["index"] != undefined) {
            this.index = clamp(0, Config.instrumentAutomationTargets[this.target].maxCount, envelopeObject["index"] | 0);
        } else {
            this.index = 0;
        }

        if (envelopeObject["pitchEnvelopeStart"] != undefined) {
            this.pitchEnvelopeStart = clamp(0, this.isNoiseEnvelope ? Config.drumCount : Config.maxPitch + 1, envelopeObject["pitchEnvelopeStart"]);
        } else {
            this.pitchEnvelopeStart = 0;
        }

        if (envelopeObject["pitchEnvelopeEnd"] != undefined) {
            this.pitchEnvelopeEnd = clamp(0, this.isNoiseEnvelope ? Config.drumCount : Config.maxPitch + 1, envelopeObject["pitchEnvelopeEnd"]);
        } else {
            this.pitchEnvelopeEnd = this.isNoiseEnvelope ? Config.drumCount : Config.maxPitch;
        }

        this.inverse = Boolean(envelopeObject["inverse"]);

        if (envelopeObject["perEnvelopeSpeed"] != undefined) {
            this.perEnvelopeSpeed = envelopeObject["perEnvelopeSpeed"];
        } else {
            this.perEnvelopeSpeed = Config.envelopes.dictionary[envelopeObject["envelope"]].speed;
        }

        if (envelopeObject["perEnvelopeLowerBound"] != undefined) {
            this.perEnvelopeLowerBound = clamp(Config.perEnvelopeBoundMin, Config.perEnvelopeBoundMax + 1, envelopeObject["perEnvelopeLowerBound"]);
        } else {
            this.perEnvelopeLowerBound = 0;
        }

        if (envelopeObject["perEnvelopeUpperBound"] != undefined) {
            this.perEnvelopeUpperBound = clamp(Config.perEnvelopeBoundMin, Config.perEnvelopeBoundMax + 1, envelopeObject["perEnvelopeUpperBound"]);
        } else {
            this.perEnvelopeUpperBound = 1;
        }

        //convert tremolo2 settings into lfo
        if (isTremolo2) {
            if (this.inverse) {
                this.perEnvelopeUpperBound = Math.floor((this.perEnvelopeUpperBound / 2) * 10) / 10;
                this.perEnvelopeLowerBound = Math.floor((this.perEnvelopeLowerBound / 2) * 10) / 10;
            } else {
                this.perEnvelopeUpperBound = Math.floor((0.5 + (this.perEnvelopeUpperBound - this.perEnvelopeLowerBound) / 2) * 10) / 10;
                this.perEnvelopeLowerBound = 0.5;
            }
        }

        if (envelopeObject["steps"] != undefined) {
            this.steps = clamp(1, Config.randomEnvelopeStepsMax + 1, envelopeObject["steps"]);
        } else {
            this.steps = 2;
        }

        if (envelopeObject["seed"] != undefined) {
            this.seed = clamp(1, Config.randomEnvelopeSeedMax + 1, envelopeObject["seed"]);
        } else {
            this.seed = 2;
        }

        if (envelopeObject["waveform"] != undefined) {
            this.waveform = envelopeObject["waveform"];
        } else {
            this.waveform = LFOEnvelopeTypes.sine;
        }

        if (envelopeObject["discrete"] != undefined) {
            this.discrete = envelopeObject["discrete"];
        } else {
            this.discrete = false;
        }
    }
}



// Settings that were available to old versions of BeepBox but are no longer available in the
// current version that need to be reinterpreted as a group to determine the best way to
// represent them in the current version.
interface LegacySettings {
    filterCutoff?: number;
    filterResonance?: number;
    filterEnvelope?: Envelope;
    pulseEnvelope?: Envelope;
    operatorEnvelopes?: Envelope[];
    feedbackEnvelope?: Envelope;
}

export interface HeldMod {
    volume: number;
    channelIndex: number;
    instrumentIndex: number;
    setting: number;
    holdFor: number;
}

export class Instrument {
    public type: InstrumentType = InstrumentType.chip;
    public preset: number = 0;
    public chipWave: number = 2;
    // advloop addition
    public isUsingAdvancedLoopControls: boolean = false;
    public chipWaveLoopStart: number = 0;
    public chipWaveLoopEnd = Config.rawRawChipWaves[this.chipWave].samples.length - 1;
    public chipWaveLoopMode: number = 0; // 0: loop, 1: ping-pong, 2: once, 3: play loop once
    public chipWavePlayBackwards: boolean = false;
    public chipWaveStartOffset: number = 0;
    // advloop addition
    public chipNoise: number = 1;
    public eqFilter: FilterSettings = new FilterSettings();
    public eqFilterType: boolean = false;
    public eqFilterSimpleCut: number = Config.filterSimpleCutRange - 1;
    public eqFilterSimplePeak: number = 0;
    public noteFilter: FilterSettings = new FilterSettings();
    public noteFilterType: boolean = false;
    public noteFilterSimpleCut: number = Config.filterSimpleCutRange - 1;
    public noteFilterSimplePeak: number = 0;
    public eqSubFilters: (FilterSettings | null)[] = [];
    public noteSubFilters: (FilterSettings | null)[] = [];
    public tmpEqFilterStart: FilterSettings | null;
    public tmpEqFilterEnd: FilterSettings | null;
    public tmpNoteFilterStart: FilterSettings | null;
    public tmpNoteFilterEnd: FilterSettings | null;
    public envelopes: EnvelopeSettings[] = [];
    public fadeIn: number = 0;
    public fadeOut: number = Config.fadeOutNeutral;
    public envelopeCount: number = 0;
    public transition: number = Config.transitions.dictionary["normal"].index;
    public pitchShift: number = 0;
    public detune: number = 0;
    // BreakBox: when enabled, custom samples play at their original speed
    // regardless of the pitch shift / detune settings (no chipmunk effect).
    public samplePitchLock: boolean = false;
    public vibrato: number = 0;
    public interval: number = 0;
    public vibratoDepth: number = 0;
    public vibratoSpeed: number = 10;
    public vibratoDelay: number = 0;
    public vibratoType: number = 0;
    public envelopeSpeed: number = 12;
    public unison: number = 0;
    public unisonVoices: number = 1;
    public unisonSpread: number = 0.0;
    public unisonOffset: number = 0.0;
    public unisonExpression: number = 1.4;
    public unisonSign: number = 1.0;
    public unisonInitialized: boolean = true;
    public effects: number = 0;
    public chord: number = 1;
    public volume: number = 0;
    public pan: number = Config.panCenter;
    public panDelay: number = 0;
    public arpeggioSpeed: number = 12;
    public monoChordTone: number = 0;
    public fastTwoNoteArp: boolean = false;
    public legacyTieOver: boolean = false;
    public clicklessTransition: boolean = false;
    public aliases: boolean = false;
    public pulseWidth: number = Config.pulseWidthRange;
    public decimalOffset: number = 0;
    public supersawDynamism: number = Config.supersawDynamismMax;
    public supersawSpread: number = Math.ceil(Config.supersawSpreadMax / 2.0);
    public supersawShape: number = 0;
    public stringSustain: number = 10;
    public stringSustainType: SustainType = SustainType.acoustic;
    public distortion: number = 0;
    public bitcrusherFreq: number = 0;
    public bitcrusherQuantization: number = 0;
    public ringModulation: number = Config.ringModRange >> 1;
    public ringModulationHz: number = Config.ringModHzRange >> 1;
    public ringModWaveformIndex: number = 0;
    public ringModPulseWidth: number = Config.pwmOperatorWaves.length >> 1;
    public ringModHzOffset: number = 200;
    public granular: number = 4;
    public grainSize: number = (Config.grainSizeMax - Config.grainSizeMin) / Config.grainSizeStep;
    public grainAmounts: number = Config.grainAmountsMax;
    public grainRange: number = 40;
    public chorus: number = 0;
    public reverb: number = 0;
    public echoSustain: number = 0;
    public echoDelay: number = 0;
    public phaserFreq: number = 0;
    public phaserMix: number = Config.phaserMixRange - 1;
    public phaserFeedback: number = 0;
    public phaserStages: number = 2;
    
    public invertWave: boolean = false;

    public algorithm: number = 0;
    public feedbackType: number = 0;
    public algorithm6Op: number = 1;
    public feedbackType6Op: number = 1;//default to not custom
    public customAlgorithm: CustomAlgorithm = new CustomAlgorithm(); //{ name: "1←4(2←5 3←6", carrierCount: 3, associatedCarrier: [1, 2, 3, 1, 2, 3], modulatedBy: [[2, 3, 4], [5], [6], [], [], []] };
    public customFeedbackType: CustomFeedBack = new CustomFeedBack(); //{ name: "1↔4 2↔5 3↔6", indices: [[3], [5], [6], [1], [2], [3]] };
    public feedbackAmplitude: number = 0;
    public customChipWave: Float32Array = new Float32Array(64);
    public customChipWaveIntegral: Float32Array = new Float32Array(65); // One extra element for wrap-around in chipSynth.
    public readonly operators: Operator[] = [];
    public readonly spectrumWave: SpectrumWave;
    public readonly harmonicsWave: HarmonicsWave = new HarmonicsWave();
    public readonly drumsetEnvelopes: number[] = [];
    public readonly drumsetSpectrumWaves: SpectrumWave[] = [];
    public modChannels: number[] = [];
    public modInstruments: number[] = [];
    public modulators: number[] = [];
    public modFilterTypes: number[] = [];
    public modEnvelopeNumbers: number[] = [];
    public invalidModulators: boolean[] = [];
    public upperNoteLimit: number = Config.maxPitch;
    public lowerNoteLimit: number = 0;
    
    //Literally just for pitch envelopes. 
    public isNoiseInstrument: boolean = false;
    constructor(isNoiseChannel: boolean, isModChannel: boolean) {

        // @jummbus - My screed on how modulator arrays for instruments work, for the benefit of myself in the future, or whoever else.
        //
        // modulators[mod] is the index in Config.modulators to use, with "none" being the first entry.
        //
        // modChannels[mod] gives the index of a channel set for this mod. Two special values:
        //   -2 "none"
        //   -1 "song"
        //   0+ actual channel index
        //
        // modInstruments[mod] gives the index of an instrument within the channel set for this mod. Again, two special values:
        //   [0 ~ channel.instruments.length-1]     channel's instrument index
        //   channel.instruments.length             "all"
        //   channel.instruments.length+1           "active"
        //
        // modFilterTypes[mod] gives some info about the filter type: 0 is morph, 1+ is index in the dot selection array (dot 1 x, dot 1 y, dot 2 x...)
        //   0  filter morph
        //   1+ filter dot target, starting from dot 1 x and then dot 1 y, then repeating x, y for all dots in order. Note: odd values are always "x" targets, even are "y".

        if (isModChannel) {
            for (let mod: number = 0; mod < Config.modCount; mod++) {
                this.modChannels.push(-2);
                this.modInstruments.push(0);
                this.modulators.push(Config.modulators.dictionary["none"].index);
            }
        }

        this.spectrumWave = new SpectrumWave(isNoiseChannel);
        for (let i: number = 0; i < Config.operatorCount + 2; i++) {//hopefully won't break everything
            this.operators[i] = new Operator(i);
        }
        for (let i: number = 0; i < Config.drumCount; i++) {
            this.drumsetEnvelopes[i] = Config.envelopes.dictionary["twang 2"].index;
            this.drumsetSpectrumWaves[i] = new SpectrumWave(true);
        }

        for (let i = 0; i < 64; i++) {
            this.customChipWave[i] = 24 - Math.floor(i * (48 / 64));
        }

        let sum: number = 0.0;
        for (let i: number = 0; i < this.customChipWave.length; i++) {
            sum += this.customChipWave[i];
        }
        const average: number = sum / this.customChipWave.length;

        // Perform the integral on the wave. The chipSynth will perform the derivative to get the original wave back but with antialiasing.
        let cumulative: number = 0;
        let wavePrev: number = 0;
        for (let i: number = 0; i < this.customChipWave.length; i++) {
            cumulative += wavePrev;
            wavePrev = this.customChipWave[i] - average;
            this.customChipWaveIntegral[i] = cumulative;
        }

        // 65th, last sample is for anti-aliasing
        this.customChipWaveIntegral[64] = 0.0;

        //properly sets the isNoiseInstrument value
        this.isNoiseInstrument = isNoiseChannel;

    }

    public setTypeAndReset(type: InstrumentType, isNoiseChannel: boolean, isModChannel: boolean): void {
        // Mod channels are forced to one type.
        if (isModChannel) type = InstrumentType.mod;
        this.type = type;
        this.preset = type;
        this.volume = 0;
        this.effects = (1 << EffectType.panning); // Panning enabled by default in JB.
        this.chorus = Config.chorusRange - 1;
        this.reverb = 0;
        this.echoSustain = Math.floor((Config.echoSustainRange - 1) * 0.5);
        this.echoDelay = Math.floor((Config.echoDelayRange - 1) * 0.5);
        this.eqFilter.reset();
        this.eqFilterType = false;
        this.eqFilterSimpleCut = Config.filterSimpleCutRange - 1;
        this.eqFilterSimplePeak = 0;
        for (let i: number = 0; i < Config.filterMorphCount; i++) {
            this.eqSubFilters[i] = null;
            this.noteSubFilters[i] = null;
        }
        this.noteFilter.reset();
        this.noteFilterType = false;
        this.noteFilterSimpleCut = Config.filterSimpleCutRange - 1;
        this.noteFilterSimplePeak = 0;
        this.distortion = Math.floor((Config.distortionRange - 1) * 0.75);
        this.bitcrusherFreq = Math.floor((Config.bitcrusherFreqRange - 1) * 0.5)
        this.bitcrusherQuantization = Math.floor((Config.bitcrusherQuantizationRange - 1) * 0.5);

        this.ringModulation = Config.ringModRange >> 1;
        this.ringModulationHz = Config.ringModHzRange >> 1;
        this.ringModWaveformIndex = 0;
        this.ringModPulseWidth = Config.pwmOperatorWaves.length >> 1;
        this.ringModHzOffset = 200;

        this.granular = 4;
        this.grainSize = (Config.grainSizeMax - Config.grainSizeMin) / Config.grainSizeStep;
        this.grainAmounts = Config.grainAmountsMax;
        this.grainRange = 40;

        this.phaserFreq	= 0;
        this.phaserFeedback = 0;
        this.phaserStages = 2;
        this.phaserMix = Config.phaserMixRange - 1;

        this.invertWave = false;
        
        this.pan = Config.panCenter;
        this.panDelay = 0;
        this.pitchShift = Config.pitchShiftCenter;
        this.detune = Config.detuneCenter;
        this.vibrato = 0;
        this.unison = 0;
        this.stringSustain = 10;
        this.stringSustainType = Config.enableAcousticSustain ? SustainType.acoustic : SustainType.bright;
        this.clicklessTransition = false;
        this.arpeggioSpeed = 12;
        this.monoChordTone = 1;
        this.envelopeSpeed = 12;
        this.legacyTieOver = false;
        this.aliases = false;
        this.fadeIn = 0;
        this.fadeOut = Config.fadeOutNeutral;
        this.transition = Config.transitions.dictionary["normal"].index;
        this.envelopeCount = 0;
        this.upperNoteLimit = Config.maxPitch;
        this.lowerNoteLimit = 0;
        this.isNoiseInstrument = isNoiseChannel;
        switch (type) {
            case InstrumentType.chip:
                this.chipWave = 2;
                // TODO: enable the chord effect? //slarmoo - My decision is no, others can if they would like though
                this.chord = Config.chords.dictionary["arpeggio"].index;
                // advloop addition
                this.isUsingAdvancedLoopControls = false;
                this.chipWaveLoopStart = 0;
                this.chipWaveLoopEnd = Config.rawRawChipWaves[this.chipWave].samples.length - 1;
                this.chipWaveLoopMode = 0;
                this.chipWavePlayBackwards = false;
                this.chipWaveStartOffset = 0;
                // advloop addition
                break;
            case InstrumentType.customChipWave:
                this.chipWave = 2;
                this.chord = Config.chords.dictionary["arpeggio"].index;
                for (let i: number = 0; i < 64; i++) {
                    this.customChipWave[i] = 24 - (Math.floor(i * (48 / 64)));
                }

                let sum: number = 0.0;
                for (let i: number = 0; i < this.customChipWave.length; i++) {
                    sum += this.customChipWave[i];
                }
                const average: number = sum / this.customChipWave.length;

                // Perform the integral on the wave. The chipSynth will perform the derivative to get the original wave back but with antialiasing.
                let cumulative: number = 0;
                let wavePrev: number = 0;
                for (let i: number = 0; i < this.customChipWave.length; i++) {
                    cumulative += wavePrev;
                    wavePrev = this.customChipWave[i] - average;
                    this.customChipWaveIntegral[i] = cumulative;
                }

                this.customChipWaveIntegral[64] = 0.0;
                break;
            case InstrumentType.fm:
                this.chord = Config.chords.dictionary["custom interval"].index;
                this.algorithm = 0;
                this.feedbackType = 0;
                this.feedbackAmplitude = 0;
                for (let i: number = 0; i < this.operators.length; i++) {
                    this.operators[i].reset(i);
                }
                break;
            case InstrumentType.fm6op:
                this.transition = 1;
                this.vibrato = 0;
                this.effects = 1;
                this.chord = 3;
                this.algorithm = 0;
                this.feedbackType = 0;
                this.algorithm6Op = 1;
                this.feedbackType6Op = 1;
                this.customAlgorithm.fromPreset(1);
                this.feedbackAmplitude = 0;
                for (let i: number = 0; i < this.operators.length; i++) {
                    this.operators[i].reset(i);
                }
                break;
            case InstrumentType.noise:
                this.chipNoise = 1;
                this.chord = Config.chords.dictionary["arpeggio"].index;
                break;
            case InstrumentType.spectrum:
                this.chord = Config.chords.dictionary["simultaneous"].index;
                this.spectrumWave.reset(isNoiseChannel);
                break;
            case InstrumentType.drumset:
                this.chord = Config.chords.dictionary["simultaneous"].index;
                for (let i: number = 0; i < Config.drumCount; i++) {
                    this.drumsetEnvelopes[i] = Config.envelopes.dictionary["twang 2"].index;
                    if (this.drumsetSpectrumWaves[i] == undefined) {
                        this.drumsetSpectrumWaves[i] = new SpectrumWave(true);
                    }
                    this.drumsetSpectrumWaves[i].reset(isNoiseChannel);
                }
                break;
            case InstrumentType.harmonics:
                this.chord = Config.chords.dictionary["simultaneous"].index;
                this.harmonicsWave.reset();
                break;
            case InstrumentType.pwm:
                this.chord = Config.chords.dictionary["arpeggio"].index;
                this.pulseWidth = Config.pulseWidthRange;
                this.decimalOffset = 0;
                break;
            case InstrumentType.pickedString:
                this.chord = Config.chords.dictionary["strum"].index;
                this.harmonicsWave.reset();
                break;
            case InstrumentType.mod:
                this.transition = 0;
                this.vibrato = 0;
                this.interval = 0;
                this.effects = 0;
                this.chord = 0;
                this.modChannels = [];
                this.modInstruments = [];
                this.modulators = [];
                for (let mod: number = 0; mod < Config.modCount; mod++) {
                    this.modChannels.push(-2);
                    this.modInstruments.push(0);
                    this.modulators.push(Config.modulators.dictionary["none"].index);
                    this.invalidModulators[mod] = false;
                    this.modFilterTypes[mod] = 0;
                    this.modEnvelopeNumbers[mod] = 0;
                }
                break;
            case InstrumentType.supersaw:
                this.chord = Config.chords.dictionary["arpeggio"].index;
                this.supersawDynamism = Config.supersawDynamismMax;
                this.supersawSpread = Math.ceil(Config.supersawSpreadMax / 2.0);
                this.supersawShape = 0;
                this.pulseWidth = Config.pulseWidthRange - 1;
                this.decimalOffset = 0;
                break;
            default:
                throw new Error("Unrecognized instrument type: " + type);
        }
        // Chip/noise instruments had arpeggio and FM had custom interval but neither
        // explicitly saved the chorus setting beforeSeven so enable it here. The effects
        // will otherwise get overridden when reading SongTagCode.startInstrument.
        if (this.chord != Config.chords.dictionary["simultaneous"].index) {
            // Enable chord if it was used.
            this.effects = (this.effects | (1 << EffectType.chord));
        }
    }

    // (only) difference for JummBox: Returns whether or not the note filter was chosen for filter conversion.
    public convertLegacySettings(legacySettings: LegacySettings, forceSimpleFilter: boolean): void {
        let legacyCutoffSetting: number | undefined = legacySettings.filterCutoff;
        let legacyResonanceSetting: number | undefined = legacySettings.filterResonance;
        let legacyFilterEnv: Envelope | undefined = legacySettings.filterEnvelope;
        let legacyPulseEnv: Envelope | undefined = legacySettings.pulseEnvelope;
        let legacyOperatorEnvelopes: Envelope[] | undefined = legacySettings.operatorEnvelopes;
        let legacyFeedbackEnv: Envelope | undefined = legacySettings.feedbackEnvelope;

        // legacy defaults:
        if (legacyCutoffSetting == undefined) legacyCutoffSetting = (this.type == InstrumentType.chip) ? 6 : 10;
        if (legacyResonanceSetting == undefined) legacyResonanceSetting = 0;
        if (legacyFilterEnv == undefined) legacyFilterEnv = Config.envelopes.dictionary["none"];
        if (legacyPulseEnv == undefined) legacyPulseEnv = Config.envelopes.dictionary[(this.type == InstrumentType.pwm) ? "twang 2" : "none"];
        if (legacyOperatorEnvelopes == undefined) legacyOperatorEnvelopes = [Config.envelopes.dictionary[(this.type == InstrumentType.fm) ? "note size" : "none"], Config.envelopes.dictionary["none"], Config.envelopes.dictionary["none"], Config.envelopes.dictionary["none"]];
        if (legacyFeedbackEnv == undefined) legacyFeedbackEnv = Config.envelopes.dictionary["none"];

        // The "punch" envelope is special: it goes *above* the chosen cutoff. But if the cutoff was already at the max, it couldn't go any higher... except in the current version of BeepBox I raised the max cutoff so it *can* but then it sounds different, so to preserve the original sound let's just remove the punch envelope.
        const legacyFilterCutoffRange: number = 11;
        const cutoffAtMax: boolean = (legacyCutoffSetting == legacyFilterCutoffRange - 1);
        if (cutoffAtMax && legacyFilterEnv.type == EnvelopeType.punch) legacyFilterEnv = Config.envelopes.dictionary["none"];

        const carrierCount: number = Config.algorithms[this.algorithm].carrierCount;
        let noCarriersControlledByNoteSize: boolean = true;
        let allCarriersControlledByNoteSize: boolean = true;
        let noteSizeControlsSomethingElse: boolean = (legacyFilterEnv.type == EnvelopeType.noteSize) || (legacyPulseEnv.type == EnvelopeType.noteSize);
        if (this.type == InstrumentType.fm || this.type == InstrumentType.fm6op) {
            noteSizeControlsSomethingElse = noteSizeControlsSomethingElse || (legacyFeedbackEnv.type == EnvelopeType.noteSize);
            for (let i: number = 0; i < legacyOperatorEnvelopes.length; i++) {
                if (i < carrierCount) {
                    if (legacyOperatorEnvelopes[i].type != EnvelopeType.noteSize) {
                        allCarriersControlledByNoteSize = false;
                    } else {
                        noCarriersControlledByNoteSize = false;
                    }
                } else {
                    noteSizeControlsSomethingElse = noteSizeControlsSomethingElse || (legacyOperatorEnvelopes[i].type == EnvelopeType.noteSize);
                }
            }
        }

        this.envelopeCount = 0;

        if (this.type == InstrumentType.fm || this.type == InstrumentType.fm6op) {
            if (allCarriersControlledByNoteSize && noteSizeControlsSomethingElse) {
                this.addEnvelope(Config.instrumentAutomationTargets.dictionary["noteVolume"].index, 0, Config.envelopes.dictionary["note size"].index, false);
            } else if (noCarriersControlledByNoteSize && !noteSizeControlsSomethingElse) {
                this.addEnvelope(Config.instrumentAutomationTargets.dictionary["none"].index, 0, Config.envelopes.dictionary["note size"].index, false);
            }
        }

        if (legacyFilterEnv.type == EnvelopeType.none) {
            this.noteFilter.reset();
            this.noteFilterType = false;
            this.eqFilter.convertLegacySettings(legacyCutoffSetting, legacyResonanceSetting, legacyFilterEnv);
            this.effects &= ~(1 << EffectType.noteFilter);
            if (forceSimpleFilter || this.eqFilterType) {
                this.eqFilterType = true;
                this.eqFilterSimpleCut = legacyCutoffSetting;
                this.eqFilterSimplePeak = legacyResonanceSetting;
            }
        } else {
            this.eqFilter.reset();

            this.eqFilterType = false;
            this.noteFilterType = false;
            this.noteFilter.convertLegacySettings(legacyCutoffSetting, legacyResonanceSetting, legacyFilterEnv);
            this.effects |= 1 << EffectType.noteFilter;
            this.addEnvelope(Config.instrumentAutomationTargets.dictionary["noteFilterAllFreqs"].index, 0, legacyFilterEnv.index, false);
            if (forceSimpleFilter || this.noteFilterType) {
                this.noteFilterType = true;
                this.noteFilterSimpleCut = legacyCutoffSetting;
                this.noteFilterSimplePeak = legacyResonanceSetting;
            }
        }

        if (legacyPulseEnv.type != EnvelopeType.none) {
            this.addEnvelope(Config.instrumentAutomationTargets.dictionary["pulseWidth"].index, 0, legacyPulseEnv.index, false);
        }

        for (let i: number = 0; i < legacyOperatorEnvelopes.length; i++) {
            if (i < carrierCount && allCarriersControlledByNoteSize) continue;
            if (legacyOperatorEnvelopes[i].type != EnvelopeType.none) {
                this.addEnvelope(Config.instrumentAutomationTargets.dictionary["operatorAmplitude"].index, i, legacyOperatorEnvelopes[i].index, false);
            }
        }

        if (legacyFeedbackEnv.type != EnvelopeType.none) {
            this.addEnvelope(Config.instrumentAutomationTargets.dictionary["feedbackAmplitude"].index, 0, legacyFeedbackEnv.index, false);
        }
    }

    public toJsonObject(): Object {
        const instrumentObject: any = {
            "type": Config.instrumentTypeNames[this.type],
            "volume": this.volume,
            "eqFilter": this.eqFilter.toJsonObject(),
            "eqFilterType": this.eqFilterType,
            "eqSimpleCut": this.eqFilterSimpleCut,
            "eqSimplePeak": this.eqFilterSimplePeak,
            "envelopeSpeed": this.envelopeSpeed
        };

        if (this.preset != this.type) {
            instrumentObject["preset"] = this.preset;
        }

        for (let i: number = 0; i < Config.filterMorphCount; i++) {
            if (this.eqSubFilters[i] != null)
                instrumentObject["eqSubFilters" + i] = this.eqSubFilters[i]!.toJsonObject();
        }

        const effects: string[] = [];
        for (const effect of Config.effectOrder) {
            if (this.effects & (1 << effect)) {
                effects.push(Config.effectNames[effect]);
            }
        }
        instrumentObject["effects"] = effects;


        if (effectsIncludeTransition(this.effects)) {
            instrumentObject["transition"] = Config.transitions[this.transition].name;
            instrumentObject["clicklessTransition"] = this.clicklessTransition;
        }
        if (effectsIncludeChord(this.effects)) {
            instrumentObject["chord"] = this.getChord().name;
            instrumentObject["fastTwoNoteArp"] = this.fastTwoNoteArp;
            instrumentObject["arpeggioSpeed"] = this.arpeggioSpeed;
            instrumentObject["monoChordTone"] = this.monoChordTone;
        }
        if (effectsIncludePitchShift(this.effects)) {
            instrumentObject["pitchShiftSemitones"] = this.pitchShift;
        }
        if (effectsIncludeDetune(this.effects)) {
            instrumentObject["detuneCents"] = Synth.detuneToCents(this.detune);
        }
        if (this.samplePitchLock) {
            instrumentObject["samplePitchLock"] = true;
        }
        if (effectsIncludeVibrato(this.effects)) {
            if (this.vibrato == -1) {
                this.vibrato = 5;
            }
            if (this.vibrato != 5) {
                instrumentObject["vibrato"] = Config.vibratos[this.vibrato].name;
            } else {
                instrumentObject["vibrato"] = "custom";
            }
            instrumentObject["vibratoDepth"] = this.vibratoDepth;
            instrumentObject["vibratoDelay"] = this.vibratoDelay;
            instrumentObject["vibratoSpeed"] = this.vibratoSpeed;
            instrumentObject["vibratoType"] = this.vibratoType;
        }
        if (effectsIncludeNoteFilter(this.effects)) {
            instrumentObject["noteFilterType"] = this.noteFilterType;
            instrumentObject["noteSimpleCut"] = this.noteFilterSimpleCut;
            instrumentObject["noteSimplePeak"] = this.noteFilterSimplePeak;
            instrumentObject["noteFilter"] = this.noteFilter.toJsonObject();

            for (let i: number = 0; i < Config.filterMorphCount; i++) {
                if (this.noteSubFilters[i] != null)
                    instrumentObject["noteSubFilters" + i] = this.noteSubFilters[i]!.toJsonObject();
            }
        }
        if (effectsIncludeGranular(this.effects)) {
            instrumentObject["granular"] = this.granular;
            instrumentObject["grainSize"] = this.grainSize;
            instrumentObject["grainAmounts"] = this.grainAmounts;
            instrumentObject["grainRange"] = this.grainRange;
        }
        if (effectsIncludeRingModulation(this.effects)) {
            instrumentObject["ringMod"] = Math.round(100 * this.ringModulation / (Config.ringModRange - 1));
            instrumentObject["ringModHz"] = Math.round(100 * this.ringModulationHz / (Config.ringModHzRange - 1));
            instrumentObject["ringModWaveformIndex"] = this.ringModWaveformIndex;
            instrumentObject["ringModPulseWidth"] = Math.round(100 * this.ringModPulseWidth / (Config.pulseWidthRange - 1));
            instrumentObject["ringModHzOffset"] = Math.round(100 * this.ringModHzOffset / (Config.rmHzOffsetMax));
        }
        if (effectsIncludePhaser(this.effects)) {
            instrumentObject["phaserMix"] =  Math.round(100 *this.phaserMix/(Config.phaserMixRange - 1));
            instrumentObject["phaserFreq"] =  Math.round(100 *this.phaserFreq/(Config.phaserFreqRange - 1));
            instrumentObject["phaserFeedback"] =  Math.round(100 *this.phaserFeedback/(Config.phaserFeedbackRange - 1));
            instrumentObject["phaserStages"] =  Math.round(100 *this.phaserStages/(Config.phaserMaxStages - 1));
        }
        if (effectsIncludeDistortion(this.effects)) {
            instrumentObject["distortion"] = Math.round(100 * this.distortion / (Config.distortionRange - 1));
            instrumentObject["aliases"] = this.aliases;
        }
        if (effectsIncludeBitcrusher(this.effects)) {
            instrumentObject["bitcrusherOctave"] = (Config.bitcrusherFreqRange - 1 - this.bitcrusherFreq) * Config.bitcrusherOctaveStep;
            instrumentObject["bitcrusherQuantization"] = Math.round(100 * this.bitcrusherQuantization / (Config.bitcrusherQuantizationRange - 1));
        }
        if (effectsIncludeInvertWave(this.effects)) {
            instrumentObject["invertWave"] =  this.invertWave;
        }
        if (effectsIncludePanning(this.effects)) {
            instrumentObject["pan"] = Math.round(100 * (this.pan - Config.panCenter) / Config.panCenter);
            instrumentObject["panDelay"] = this.panDelay;
        }
        if (effectsIncludeChorus(this.effects)) {
            instrumentObject["chorus"] = Math.round(100 * this.chorus / (Config.chorusRange - 1));
        }
        if (effectsIncludeEcho(this.effects)) {
            instrumentObject["echoSustain"] = Math.round(100 * this.echoSustain / (Config.echoSustainRange - 1));
            instrumentObject["echoDelayBeats"] = Math.round(1000 * (this.echoDelay + 1) * Config.echoDelayStepTicks / (Config.ticksPerPart * Config.partsPerBeat)) / 1000;
        }
        if (effectsIncludeReverb(this.effects)) {
            instrumentObject["reverb"] = Math.round(100 * this.reverb / (Config.reverbRange - 1));
        }
        if (effectsIncludeNoteRange(this.effects)) {
            instrumentObject["upperNoteLimit"] = this.upperNoteLimit;
            instrumentObject["lowerNoteLimit"] = this.lowerNoteLimit;
        }
        

        if (this.type != InstrumentType.drumset) {
            instrumentObject["fadeInSeconds"] = Math.round(10000 * Synth.fadeInSettingToSeconds(this.fadeIn)) / 10000;
            instrumentObject["fadeOutTicks"] = Synth.fadeOutSettingToTicks(this.fadeOut);
        }

        if (this.type == InstrumentType.harmonics || this.type == InstrumentType.pickedString) {
            instrumentObject["harmonics"] = [];
            for (let i: number = 0; i < Config.harmonicsControlPoints; i++) {
                instrumentObject["harmonics"][i] = Math.round(100 * this.harmonicsWave.harmonics[i] / Config.harmonicsMax);
            }
        }

        if (this.type == InstrumentType.noise) {
            instrumentObject["wave"] = Config.chipNoises[this.chipNoise].name;
            instrumentObject["unison"] = this.unison == Config.unisons.length ? "custom" : Config.unisons[this.unison].name;
            if (this.unison == Config.unisons.length) {
                instrumentObject["unisonVoices"] = this.unisonVoices;
                instrumentObject["unisonSpread"] = this.unisonSpread;
                instrumentObject["unisonOffset"] = this.unisonOffset;
                instrumentObject["unisonExpression"] = this.unisonExpression;
                instrumentObject["unisonSign"] = this.unisonSign;
            }
        } else if (this.type == InstrumentType.spectrum) {
            instrumentObject["spectrum"] = [];
            for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
                instrumentObject["spectrum"][i] = Math.round(100 * this.spectrumWave.spectrum[i] / Config.spectrumMax);
            }
            instrumentObject["unison"] = this.unison == Config.unisons.length ? "custom" : Config.unisons[this.unison].name;
            if (this.unison == Config.unisons.length) {
                instrumentObject["unisonVoices"] = this.unisonVoices;
                instrumentObject["unisonSpread"] = this.unisonSpread;
                instrumentObject["unisonOffset"] = this.unisonOffset;
                instrumentObject["unisonExpression"] = this.unisonExpression;
                instrumentObject["unisonSign"] = this.unisonSign;
            }
        } else if (this.type == InstrumentType.drumset) {
            instrumentObject["drums"] = [];
            instrumentObject["unison"] = this.unison == Config.unisons.length ? "custom" : Config.unisons[this.unison].name;
            if (this.unison == Config.unisons.length) {
                instrumentObject["unisonVoices"] = this.unisonVoices;
                instrumentObject["unisonSpread"] = this.unisonSpread;
                instrumentObject["unisonOffset"] = this.unisonOffset;
                instrumentObject["unisonExpression"] = this.unisonExpression;
                instrumentObject["unisonSign"] = this.unisonSign;
            }
            for (let j: number = 0; j < Config.drumCount; j++) {
                const spectrum: number[] = [];
                for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
                    spectrum[i] = Math.round(100 * this.drumsetSpectrumWaves[j].spectrum[i] / Config.spectrumMax);
                }
                instrumentObject["drums"][j] = {
                    "filterEnvelope": this.getDrumsetEnvelope(j).name,
                    "spectrum": spectrum,
                };
            }
        } else if (this.type == InstrumentType.chip) {
            instrumentObject["wave"] = Config.chipWaves[this.chipWave].name;
            // should this unison pushing code be turned into a function..?
            instrumentObject["unison"] = this.unison == Config.unisons.length ? "custom" : Config.unisons[this.unison].name;
            // these don't need to be pushed if custom unisons aren't being used
            if (this.unison == Config.unisons.length) {
                instrumentObject["unisonVoices"] = this.unisonVoices;
                instrumentObject["unisonSpread"] = this.unisonSpread;
                instrumentObject["unisonOffset"] = this.unisonOffset;
                instrumentObject["unisonExpression"] = this.unisonExpression;
                instrumentObject["unisonSign"] = this.unisonSign;
            }

            // advloop addition
            instrumentObject["isUsingAdvancedLoopControls"] = this.isUsingAdvancedLoopControls;
            instrumentObject["chipWaveLoopStart"] = this.chipWaveLoopStart;
            instrumentObject["chipWaveLoopEnd"] = this.chipWaveLoopEnd;
            instrumentObject["chipWaveLoopMode"] = this.chipWaveLoopMode;
            instrumentObject["chipWavePlayBackwards"] = this.chipWavePlayBackwards;
            instrumentObject["chipWaveStartOffset"] = this.chipWaveStartOffset;
            // advloop addition
        } else if (this.type == InstrumentType.pwm) {
            instrumentObject["pulseWidth"] = this.pulseWidth;
            instrumentObject["decimalOffset"] = this.decimalOffset;
            instrumentObject["unison"] = this.unison == Config.unisons.length ? "custom" : Config.unisons[this.unison].name;
            if (this.unison == Config.unisons.length) {
                instrumentObject["unisonVoices"] = this.unisonVoices;
                instrumentObject["unisonSpread"] = this.unisonSpread;
                instrumentObject["unisonOffset"] = this.unisonOffset;
                instrumentObject["unisonExpression"] = this.unisonExpression;
                instrumentObject["unisonSign"] = this.unisonSign;
            }
        } else if (this.type == InstrumentType.supersaw) {
            instrumentObject["pulseWidth"] = this.pulseWidth;
            instrumentObject["decimalOffset"] = this.decimalOffset;
            instrumentObject["dynamism"] = Math.round(100 * this.supersawDynamism / Config.supersawDynamismMax);
            instrumentObject["spread"] = Math.round(100 * this.supersawSpread / Config.supersawSpreadMax);
            instrumentObject["shape"] = Math.round(100 * this.supersawShape / Config.supersawShapeMax);
            if (this.unison == Config.unisons.length) {
                instrumentObject["unisonVoices"] = this.unisonVoices;
                instrumentObject["unisonSpread"] = this.unisonSpread;
                instrumentObject["unisonOffset"] = this.unisonOffset;
                instrumentObject["unisonExpression"] = this.unisonExpression;
                instrumentObject["unisonSign"] = this.unisonSign;
            }
        } else if (this.type == InstrumentType.pickedString) {
            instrumentObject["unison"] = this.unison == Config.unisons.length ? "custom" : Config.unisons[this.unison].name;
            if (this.unison == Config.unisons.length) {
                instrumentObject["unisonVoices"] = this.unisonVoices;
                instrumentObject["unisonSpread"] = this.unisonSpread;
                instrumentObject["unisonOffset"] = this.unisonOffset;
                instrumentObject["unisonExpression"] = this.unisonExpression;
                instrumentObject["unisonSign"] = this.unisonSign;
            }
            instrumentObject["stringSustain"] = Math.round(100 * this.stringSustain / (Config.stringSustainRange - 1));
            if (Config.enableAcousticSustain) {
                instrumentObject["stringSustainType"] = Config.sustainTypeNames[this.stringSustainType];
            }
        } else if (this.type == InstrumentType.harmonics) {
            instrumentObject["unison"] = this.unison == Config.unisons.length ? "custom" : Config.unisons[this.unison].name;
            if (this.unison == Config.unisons.length) {
                instrumentObject["unisonVoices"] = this.unisonVoices;
                instrumentObject["unisonSpread"] = this.unisonSpread;
                instrumentObject["unisonOffset"] = this.unisonOffset;
                instrumentObject["unisonExpression"] = this.unisonExpression;
                instrumentObject["unisonSign"] = this.unisonSign;
            }
        } else if (this.type == InstrumentType.fm || this.type == InstrumentType.fm6op) {
            const operatorArray: Object[] = [];
            for (const operator of this.operators) {
                operatorArray.push({
                    "frequency": Config.operatorFrequencies[operator.frequency].name,
                    "amplitude": operator.amplitude,
                    "waveform": Config.operatorWaves[operator.waveform].name,
                    "pulseWidth": operator.pulseWidth,
                });
            }
            if (this.type == InstrumentType.fm) {
                instrumentObject["algorithm"] = Config.algorithms[this.algorithm].name;
                instrumentObject["feedbackType"] = Config.feedbacks[this.feedbackType].name;
                instrumentObject["feedbackAmplitude"] = this.feedbackAmplitude;
                instrumentObject["operators"] = operatorArray;
            } else {
                instrumentObject["algorithm"] = Config.algorithms6Op[this.algorithm6Op].name;
                instrumentObject["feedbackType"] = Config.feedbacks6Op[this.feedbackType6Op].name;
                instrumentObject["feedbackAmplitude"] = this.feedbackAmplitude;
                if (this.algorithm6Op == 0) {
                    const customAlgorithm: any = {};
                    customAlgorithm["mods"] = this.customAlgorithm.modulatedBy;
                    customAlgorithm["carrierCount"] = this.customAlgorithm.carrierCount;
                    instrumentObject["customAlgorithm"] = customAlgorithm;
                }
                if (this.feedbackType6Op == 0) {
                    const customFeedback: any = {};
                    customFeedback["mods"] = this.customFeedbackType.indices;
                    instrumentObject["customFeedback"] = customFeedback;
                }

                instrumentObject["operators"] = operatorArray;
            }
        } else if (this.type == InstrumentType.customChipWave) {
            instrumentObject["wave"] = Config.chipWaves[this.chipWave].name;
            instrumentObject["unison"] = this.unison == Config.unisons.length ? "custom" : Config.unisons[this.unison].name;
            if (this.unison == Config.unisons.length) {
                instrumentObject["unisonVoices"] = this.unisonVoices;
                instrumentObject["unisonSpread"] = this.unisonSpread;
                instrumentObject["unisonOffset"] = this.unisonOffset;
                instrumentObject["unisonExpression"] = this.unisonExpression;
                instrumentObject["unisonSign"] = this.unisonSign;
            }
            instrumentObject["customChipWave"] = new Float64Array(64);
            instrumentObject["customChipWaveIntegral"] = new Float64Array(65);
            for (let i: number = 0; i < this.customChipWave.length; i++) {
                instrumentObject["customChipWave"][i] = this.customChipWave[i];
                // Meh, waste of space and can be inaccurate. It will be recalc'ed when instrument loads.
                //instrumentObject["customChipWaveIntegral"][i] = this.customChipWaveIntegral[i];
            }
        } else if (this.type == InstrumentType.mod) {
            instrumentObject["modChannels"] = [];
            instrumentObject["modInstruments"] = [];
            instrumentObject["modSettings"] = [];
            instrumentObject["modFilterTypes"] = [];
            instrumentObject["modEnvelopeNumbers"] = [];
            for (let mod: number = 0; mod < Config.modCount; mod++) {
                instrumentObject["modChannels"][mod] = this.modChannels[mod];
                instrumentObject["modInstruments"][mod] = this.modInstruments[mod];
                instrumentObject["modSettings"][mod] = this.modulators[mod];
                instrumentObject["modFilterTypes"][mod] = this.modFilterTypes[mod];
                instrumentObject["modEnvelopeNumbers"][mod] = this.modEnvelopeNumbers[mod];
            }
        } else {
            throw new Error("Unrecognized instrument type");
        }

        const envelopes: any[] = [];
        for (let i = 0; i < this.envelopeCount; i++) {
            envelopes.push(this.envelopes[i].toJsonObject());
        }
        instrumentObject["envelopes"] = envelopes;

        return instrumentObject;
    }


    public fromJsonObject(instrumentObject: any, isNoiseChannel: boolean, isModChannel: boolean, useSlowerRhythm: boolean, useFastTwoNoteArp: boolean, legacyGlobalReverb: number = 0, jsonFormat: string = Config.jsonFormat): void {
        if (instrumentObject == undefined) instrumentObject = {};

        const format: string = jsonFormat.toLowerCase();

        let type: InstrumentType = Config.instrumentTypeNames.indexOf(instrumentObject["type"]);
        // SynthBox support
        if ((format == "synthbox") && (instrumentObject["type"] == "FM")) type = Config.instrumentTypeNames.indexOf("FM6op");
        if (<any>type == -1) type = isModChannel ? InstrumentType.mod : (isNoiseChannel ? InstrumentType.noise : InstrumentType.chip);
        this.setTypeAndReset(type, isNoiseChannel, isModChannel);

        this.effects &= ~(1 << EffectType.panning);

        if (instrumentObject["preset"] != undefined) {
            this.preset = instrumentObject["preset"] >>> 0;
        }

        if (instrumentObject["volume"] != undefined) {
            if (format == "jummbox" || format == "midbox" || format == "synthbox" || format == "goldbox" || format == "paandorasbox" || format == "ultrabox" || format == "slarmoosbox") {
                this.volume = clamp(-Config.volumeRange / 2, (Config.volumeRange / 2) + 1, instrumentObject["volume"] | 0);
            } else {
                this.volume = Math.round(-clamp(0, 8, Math.round(5 - (instrumentObject["volume"] | 0) / 20)) * 25.0 / 7.0);
            }
        } else {
            this.volume = 0;
        }

        //These can probably be condensed with ternary operators
        this.envelopeSpeed = instrumentObject["envelopeSpeed"] != undefined ? clamp(0, Config.modulators.dictionary["envelope speed"].maxRawVol + 1, instrumentObject["envelopeSpeed"] | 0) : 12;

        if (Array.isArray(instrumentObject["effects"])) {
            let effects: number = 0;
            for (let i: number = 0; i < instrumentObject["effects"].length; i++) {
                effects = effects | (1 << Config.effectNames.indexOf(instrumentObject["effects"][i]));
            }
            this.effects = (effects & ((1 << EffectType.length) - 1));
        } else {
            // The index of these names is reinterpreted as a bitfield, which relies on reverb and chorus being the first effects!
            const legacyEffectsNames: string[] = ["none", "reverb", "chorus", "chorus & reverb"];
            this.effects = legacyEffectsNames.indexOf(instrumentObject["effects"]);
            if (this.effects == -1) this.effects = (this.type == InstrumentType.noise) ? 0 : 1;
        }

        this.transition = Config.transitions.dictionary["normal"].index; // default value.
        const transitionProperty: any = instrumentObject["transition"] || instrumentObject["envelope"]; // the transition property used to be called envelope, so check that too.
        if (transitionProperty != undefined) {
            let transition: Transition | undefined = Config.transitions.dictionary[transitionProperty];
            if (instrumentObject["fadeInSeconds"] == undefined || instrumentObject["fadeOutTicks"] == undefined) {
                const legacySettings = (<any>{
                    "binary": { transition: "interrupt", fadeInSeconds: 0.0, fadeOutTicks: -1 },
                    "seamless": { transition: "interrupt", fadeInSeconds: 0.0, fadeOutTicks: -1 },
                    "sudden": { transition: "normal", fadeInSeconds: 0.0, fadeOutTicks: -3 },
                    "hard": { transition: "normal", fadeInSeconds: 0.0, fadeOutTicks: -3 },
                    "smooth": { transition: "normal", fadeInSeconds: 0.025, fadeOutTicks: -3 },
                    "soft": { transition: "normal", fadeInSeconds: 0.025, fadeOutTicks: -3 },
                    // Note that the old slide transition has the same name as a new slide transition that is different.
                    // Only apply legacy settings if the instrument JSON was created before, based on the presence
                    // of the fade in/out fields.
                    "slide": { transition: "slide in pattern", fadeInSeconds: 0.025, fadeOutTicks: -3 },
                    "cross fade": { transition: "normal", fadeInSeconds: 0.04, fadeOutTicks: 6 },
                    "hard fade": { transition: "normal", fadeInSeconds: 0.0, fadeOutTicks: 48 },
                    "medium fade": { transition: "normal", fadeInSeconds: 0.0125, fadeOutTicks: 72 },
                    "soft fade": { transition: "normal", fadeInSeconds: 0.06, fadeOutTicks: 96 },
                })[transitionProperty];
                if (legacySettings != undefined) {
                    transition = Config.transitions.dictionary[legacySettings.transition];
                    // These may be overridden below.
                    this.fadeIn = Synth.secondsToFadeInSetting(legacySettings.fadeInSeconds);
                    this.fadeOut = Synth.ticksToFadeOutSetting(legacySettings.fadeOutTicks);
                }
            }
            if (transition != undefined) this.transition = transition.index;

            if (this.transition != Config.transitions.dictionary["normal"].index) {
                // Enable transition if it was used.
                this.effects = (this.effects | (1 << EffectType.transition));
            }
        }

        // Overrides legacy settings in transition above.
        if (instrumentObject["fadeInSeconds"] != undefined) {
            this.fadeIn = Synth.secondsToFadeInSetting(+instrumentObject["fadeInSeconds"]);
        }
        if (instrumentObject["fadeOutTicks"] != undefined) {
            this.fadeOut = Synth.ticksToFadeOutSetting(+instrumentObject["fadeOutTicks"]);
        }

        {
            // Note that the chord setting may be overridden by instrumentObject["chorus"] below.
            const chordProperty: any = instrumentObject["chord"];
            const legacyChordNames: Dictionary<string> = { "harmony": "simultaneous" };
            const chord: Chord | undefined = Config.chords.dictionary[legacyChordNames[chordProperty]] || Config.chords.dictionary[chordProperty];
            if (chord != undefined) {
                this.chord = chord.index;
            } else {
                // Different instruments have different default chord types based on historical behaviour.
                if (this.type == InstrumentType.noise) {
                    this.chord = Config.chords.dictionary["arpeggio"].index;
                } else if (this.type == InstrumentType.pickedString) {
                    this.chord = Config.chords.dictionary["strum"].index;
                } else if (this.type == InstrumentType.chip) {
                    this.chord = Config.chords.dictionary["arpeggio"].index;
                } else if (this.type == InstrumentType.fm || this.type == InstrumentType.fm6op) {
                    this.chord = Config.chords.dictionary["custom interval"].index;
                } else {
                    this.chord = Config.chords.dictionary["simultaneous"].index;
                }
            }
        }

        this.unison = Config.unisons.dictionary["none"].index; // default value.
        const unisonProperty: any = instrumentObject["unison"] || instrumentObject["interval"] || instrumentObject["chorus"]; // The unison property has gone by various names in the past.
        if (unisonProperty != undefined) {
            const legacyChorusNames: Dictionary<string> = { "union": "none", "fifths": "fifth", "octaves": "octave", "error": "voiced" };
            const unison: Unison | undefined = Config.unisons.dictionary[legacyChorusNames[unisonProperty]] || Config.unisons.dictionary[unisonProperty];
            if (unison != undefined) this.unison = unison.index;
            if (unisonProperty == "custom") this.unison = Config.unisons.length;
        }
        //clamp these???
        this.unisonVoices = (instrumentObject["unisonVoices"] == undefined) ? Config.unisons[this.unison].voices : instrumentObject["unisonVoices"];
        this.unisonSpread = (instrumentObject["unisonSpread"] == undefined) ? Config.unisons[this.unison].spread : instrumentObject["unisonSpread"];
        this.unisonOffset = (instrumentObject["unisonOffset"] == undefined) ? Config.unisons[this.unison].offset : instrumentObject["unisonOffset"];
        this.unisonExpression = (instrumentObject["unisonExpression"] == undefined) ? Config.unisons[this.unison].expression : instrumentObject["unisonExpression"];
        this.unisonSign = (instrumentObject["unisonSign"] == undefined) ? Config.unisons[this.unison].sign : instrumentObject["unisonSign"];

        if (instrumentObject["chorus"] == "custom harmony") {
            // The original chorus setting had an option that now maps to two different settings. Override those if necessary.
            this.unison = Config.unisons.dictionary["hum"].index;
            this.chord = Config.chords.dictionary["custom interval"].index;
        }
        if (this.chord != Config.chords.dictionary["simultaneous"].index && !Array.isArray(instrumentObject["effects"])) {
            // Enable chord if it was used.
            this.effects = (this.effects | (1 << EffectType.chord));
        }

        if (instrumentObject["pitchShiftSemitones"] != undefined) {
            this.pitchShift = clamp(0, Config.pitchShiftRange, Math.round(+instrumentObject["pitchShiftSemitones"]));
        }
        // modbox pitch shift, known in that mod as "octave offset"
        if (instrumentObject["octoff"] != undefined) {
            let potentialPitchShift: string = instrumentObject["octoff"];
            this.effects = (this.effects | (1 << EffectType.pitchShift));

            if ((potentialPitchShift == "+1 (octave)") || (potentialPitchShift == "+2 (2 octaves)")) {
                this.pitchShift = 24;
            } else if ((potentialPitchShift == "+1/2 (fifth)") || (potentialPitchShift == "+1 1/2 (octave and fifth)")) {
                this.pitchShift = 18;
            } else if ((potentialPitchShift == "-1 (octave)") || (potentialPitchShift == "-2 (2 octaves")) { //this typo is in modbox
                this.pitchShift = 0;
            } else if ((potentialPitchShift == "-1/2 (fifth)") || (potentialPitchShift == "-1 1/2 (octave and fifth)")) {
                this.pitchShift = 6;
            } else {
                this.pitchShift = 12;
            }
        }
        if (instrumentObject["detuneCents"] != undefined) {
            this.detune = clamp(Config.detuneMin, Config.detuneMax + 1, Math.round(Synth.centsToDetune(+instrumentObject["detuneCents"])));
        }
        if (instrumentObject["samplePitchLock"] != undefined) {
            this.samplePitchLock = Boolean(instrumentObject["samplePitchLock"]);
        }

        this.vibrato = Config.vibratos.dictionary["none"].index; // default value.
        const vibratoProperty: any = instrumentObject["vibrato"] || instrumentObject["effect"]; // The vibrato property was previously called "effect", not to be confused with the current "effects".
        if (vibratoProperty != undefined) {

            const legacyVibratoNames: Dictionary<string> = { "vibrato light": "light", "vibrato delayed": "delayed", "vibrato heavy": "heavy" };
            const vibrato: Vibrato | undefined = Config.vibratos.dictionary[legacyVibratoNames[unisonProperty]] || Config.vibratos.dictionary[vibratoProperty];
            if (vibrato != undefined)
                this.vibrato = vibrato.index;
            else if (vibratoProperty == "custom")
                this.vibrato = Config.vibratos.length; // custom

            if (this.vibrato == Config.vibratos.length) {
                this.vibratoDepth = instrumentObject["vibratoDepth"];
                this.vibratoSpeed = instrumentObject["vibratoSpeed"];
                this.vibratoDelay = instrumentObject["vibratoDelay"];
                this.vibratoType = instrumentObject["vibratoType"];
            }
            else { // Set defaults for the vibrato profile
                this.vibratoDepth = Config.vibratos[this.vibrato].amplitude;
                this.vibratoDelay = Config.vibratos[this.vibrato].delayTicks / 2;
                this.vibratoSpeed = 10; // default;
                this.vibratoType = Config.vibratos[this.vibrato].type;
            }

            // Old songs may have a vibrato effect without explicitly enabling it.
            if (vibrato != Config.vibratos.dictionary["none"]) {
                this.effects = (this.effects | (1 << EffectType.vibrato));
            }
        }

        if (instrumentObject["pan"] != undefined) {
            this.pan = clamp(0, Config.panMax + 1, Math.round(Config.panCenter + (instrumentObject["pan"] | 0) * Config.panCenter / 100));
        } else if (instrumentObject["ipan"] != undefined) {
            // support for modbox fixed
            this.pan = clamp(0, Config.panMax + 1, Config.panCenter + (instrumentObject["ipan"] * -50));
        } else {
            this.pan = Config.panCenter;
        }

        // Old songs may have a panning effect without explicitly enabling it.
        if (this.pan != Config.panCenter) {
            this.effects = (this.effects | (1 << EffectType.panning));
        }

        if (instrumentObject["panDelay"] != undefined) {
            this.panDelay = (instrumentObject["panDelay"] | 0);
        } else {
            this.panDelay = 0;
        }

        if (instrumentObject["detune"] != undefined) {
            this.detune = clamp(Config.detuneMin, Config.detuneMax + 1, (instrumentObject["detune"] | 0));
        }
        else if (instrumentObject["detuneCents"] == undefined) {
            this.detune = Config.detuneCenter;
        }

        if (instrumentObject["ringMod"] != undefined) {
            this.ringModulation = clamp(0, Config.ringModRange, Math.round((Config.ringModRange - 1) * (instrumentObject["ringMod"] | 0) / 100));
        }
        if (instrumentObject["ringModHz"] != undefined) {
            this.ringModulationHz = clamp(0, Config.ringModHzRange, Math.round((Config.ringModHzRange - 1) * (instrumentObject["ringModHz"] | 0) / 100));
        }
        if (instrumentObject["ringModWaveformIndex"] != undefined) {
            this.ringModWaveformIndex = clamp(0, Config.operatorWaves.length, instrumentObject["ringModWaveformIndex"]);
        }
        if (instrumentObject["ringModPulseWidth"] != undefined) {
            this.ringModPulseWidth = clamp(0, Config.pulseWidthRange, Math.round((Config.pulseWidthRange - 1) * (instrumentObject["ringModPulseWidth"] | 0) / 100));
        }
        if (instrumentObject["ringModHzOffset"] != undefined) {
            this.ringModHzOffset = clamp(0, Config.rmHzOffsetMax, Math.round((Config.rmHzOffsetMax - 1) * (instrumentObject["ringModHzOffset"] | 0) / 100));
        }

        if (instrumentObject["granular"] != undefined) {
            this.granular = instrumentObject["granular"];
        }
        if (instrumentObject["grainSize"] != undefined) {
            this.grainSize = instrumentObject["grainSize"];
        }
        if (instrumentObject["grainAmounts"] != undefined) {
            this.grainAmounts = instrumentObject["grainAmounts"];
        }
        if (instrumentObject["grainRange"] != undefined) {
            this.grainRange = clamp(0, Config.grainRangeMax / Config.grainSizeStep + 1, instrumentObject["grainRange"]);
        }

        
        if (instrumentObject["phaserMix"] != undefined) {
            this.phaserMix = clamp(0, Config.phaserMixRange, Math.round((Config.phaserMixRange - 1) * (instrumentObject["phaserMix"] | 0) / 100));
        }
        if (instrumentObject["phaserFreq"] != undefined) {
            this.phaserFreq = clamp(0, Config.phaserFreqRange, Math.round((Config.phaserFreqRange - 1) * (instrumentObject["phaserFreq"] | 0) / 100));
        }
        if (instrumentObject["phaserFeedback"] != undefined) {
            this.phaserFeedback = clamp(0, Config.phaserFeedbackRange, Math.round((Config.phaserFeedbackRange - 1) * (instrumentObject["phaserFeedback"] | 0) / 100));
        }
        if (instrumentObject["phaserStages"] != undefined) {
            this.phaserStages = clamp(0, Config.phaserMaxStages, Math.round((Config.phaserMaxStages - 1) * (instrumentObject["phaserStages"] | 0) / 100));
        }


        if (instrumentObject["distortion"] != undefined) {
            this.distortion = clamp(0, Config.distortionRange, Math.round((Config.distortionRange - 1) * (instrumentObject["distortion"] | 0) / 100));
        }

        if (instrumentObject["bitcrusherOctave"] != undefined) {
            this.bitcrusherFreq = Config.bitcrusherFreqRange - 1 - (+instrumentObject["bitcrusherOctave"]) / Config.bitcrusherOctaveStep;
        }
        if (instrumentObject["bitcrusherQuantization"] != undefined) {
            this.bitcrusherQuantization = clamp(0, Config.bitcrusherQuantizationRange, Math.round((Config.bitcrusherQuantizationRange - 1) * (instrumentObject["bitcrusherQuantization"] | 0) / 100));
        }

        if (instrumentObject["echoSustain"] != undefined) {
            this.echoSustain = clamp(0, Config.echoSustainRange, Math.round((Config.echoSustainRange - 1) * (instrumentObject["echoSustain"] | 0) / 100));
        }
        if (instrumentObject["echoDelayBeats"] != undefined) {
            this.echoDelay = clamp(0, Config.echoDelayRange, Math.round((+instrumentObject["echoDelayBeats"]) * (Config.ticksPerPart * Config.partsPerBeat) / Config.echoDelayStepTicks - 1.0));
        }

        if (!isNaN(instrumentObject["chorus"])) {
            this.chorus = clamp(0, Config.chorusRange, Math.round((Config.chorusRange - 1) * (instrumentObject["chorus"] | 0) / 100));
        }

        if (instrumentObject["reverb"] != undefined) {
            this.reverb = clamp(0, Config.reverbRange, Math.round((Config.reverbRange - 1) * (instrumentObject["reverb"] | 0) / 100));
        } else {
            this.reverb = legacyGlobalReverb;
        }

        if (instrumentObject["invertWave"] != undefined) {
            this.invertWave = instrumentObject["invertWave"];
        }

        if (instrumentObject["upperNoteLimit"] != undefined) {
            this.upperNoteLimit = instrumentObject["upperNoteLimit"]
        }
        if (instrumentObject["lowerNoteLimit"] != undefined) {
            this.lowerNoteLimit = instrumentObject["lowerNoteLimit"]
        }
        
        if (instrumentObject["pulseWidth"] != undefined) {
            this.pulseWidth = clamp(1, Config.pulseWidthRange + 1, Math.round(instrumentObject["pulseWidth"]));
        } else {
            this.pulseWidth = Config.pulseWidthRange;
        }

        if (instrumentObject["decimalOffset"] != undefined) {
            this.decimalOffset = clamp(0, 99 + 1, Math.round(instrumentObject["decimalOffset"]));
        } else {
            this.decimalOffset = 0;
        }

        if (instrumentObject["dynamism"] != undefined) {
            this.supersawDynamism = clamp(0, Config.supersawDynamismMax + 1, Math.round(Config.supersawDynamismMax * (instrumentObject["dynamism"] | 0) / 100));
        } else {
            this.supersawDynamism = Config.supersawDynamismMax;
        }
        if (instrumentObject["spread"] != undefined) {
            this.supersawSpread = clamp(0, Config.supersawSpreadMax + 1, Math.round(Config.supersawSpreadMax * (instrumentObject["spread"] | 0) / 100));
        } else {
            this.supersawSpread = Math.ceil(Config.supersawSpreadMax / 2.0);
        }
        if (instrumentObject["shape"] != undefined) {
            this.supersawShape = clamp(0, Config.supersawShapeMax + 1, Math.round(Config.supersawShapeMax * (instrumentObject["shape"] | 0) / 100));
        } else {
            this.supersawShape = 0;
        }

        if (instrumentObject["harmonics"] != undefined) {
            for (let i: number = 0; i < Config.harmonicsControlPoints; i++) {
                this.harmonicsWave.harmonics[i] = Math.max(0, Math.min(Config.harmonicsMax, Math.round(Config.harmonicsMax * (+instrumentObject["harmonics"][i]) / 100)));
            }
            this.harmonicsWave.markCustomWaveDirty();
        } else {
            this.harmonicsWave.reset();
        }

        if (instrumentObject["spectrum"] != undefined) {
            for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
                this.spectrumWave.spectrum[i] = Math.max(0, Math.min(Config.spectrumMax, Math.round(Config.spectrumMax * (+instrumentObject["spectrum"][i]) / 100)));
                this.spectrumWave.markCustomWaveDirty();
            }
        } else {
            this.spectrumWave.reset(isNoiseChannel);
        }

        if (instrumentObject["stringSustain"] != undefined) {
            this.stringSustain = clamp(0, Config.stringSustainRange, Math.round((Config.stringSustainRange - 1) * (instrumentObject["stringSustain"] | 0) / 100));
        } else {
            this.stringSustain = 10;
        }
        this.stringSustainType = Config.enableAcousticSustain ? Config.sustainTypeNames.indexOf(instrumentObject["stringSustainType"]) : SustainType.bright;
        if (<any>this.stringSustainType == -1) this.stringSustainType = SustainType.bright;

        if (this.type == InstrumentType.noise) {
            this.chipNoise = Config.chipNoises.findIndex(wave => wave.name == instrumentObject["wave"]);
            if (instrumentObject["wave"] == "pink noise") this.chipNoise = Config.chipNoises.findIndex(wave => wave.name == "pink");
            if (instrumentObject["wave"] == "brownian noise") this.chipNoise = Config.chipNoises.findIndex(wave => wave.name == "brownian");
            if (this.chipNoise == -1) this.chipNoise = 1;
        }

        const legacyEnvelopeNames: Dictionary<string> = { "custom": "note size", "steady": "none", "pluck 1": "twang 1", "pluck 2": "twang 2", "pluck 3": "twang 3" };
        const getEnvelope = (name: any): Envelope | undefined => {
            if (legacyEnvelopeNames[name] != undefined) return Config.envelopes.dictionary[legacyEnvelopeNames[name]];
            else {
                return Config.envelopes.dictionary[name];
            }
        }

        if (this.type == InstrumentType.drumset) {
            if (instrumentObject["drums"] != undefined) {
                for (let j: number = 0; j < Config.drumCount; j++) {
                    const drum: any = instrumentObject["drums"][j];
                    if (drum == undefined) continue;

                    this.drumsetEnvelopes[j] = Config.envelopes.dictionary["twang 2"].index; // default value.
                    if (drum["filterEnvelope"] != undefined) {
                        const envelope: Envelope | undefined = getEnvelope(drum["filterEnvelope"]);
                        if (envelope != undefined) this.drumsetEnvelopes[j] = envelope.index;
                    }
                    if (drum["spectrum"] != undefined) {
                        for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
                            this.drumsetSpectrumWaves[j].spectrum[i] = Math.max(0, Math.min(Config.spectrumMax, Math.round(Config.spectrumMax * (+drum["spectrum"][i]) / 100)));
                        }
                    }
                    this.drumsetSpectrumWaves[j].markCustomWaveDirty();
                }
            }
        }

        if (this.type == InstrumentType.chip) {
            const legacyWaveNames: Dictionary<number> = { "triangle": 1, "square": 2, "pulse wide": 3, "pulse narrow": 4, "sawtooth": 5, "double saw": 6, "double pulse": 7, "spiky": 8, "plateau": 0 };
            const modboxWaveNames: Dictionary<number> = { "10% pulse": 22, "sunsoft bass": 23, "loud pulse": 24, "sax": 25, "guitar": 26, "atari bass": 28, "atari pulse": 29, "1% pulse": 30, "curved sawtooth": 31, "viola": 32, "brass": 33, "acoustic bass": 34, "lyre": 35, "ramp pulse": 36, "piccolo": 37, "squaretooth": 38, "flatline": 39, "pnryshk a (u5)": 40, "pnryshk b (riff)": 41 };
            const sandboxWaveNames: Dictionary<number> = { "shrill lute": 42, "shrill bass": 44, "nes pulse": 45, "saw bass": 46, "euphonium": 47, "shrill pulse": 48, "r-sawtooth": 49, "recorder": 50, "narrow saw": 51, "deep square": 52, "ring pulse": 53, "double sine": 54, "contrabass": 55, "double bass": 56 };
            const zefboxWaveNames: Dictionary<number> = { "semi-square": 63, "deep square": 64, "squaretal": 40, "saw wide": 65, "saw narrow ": 66, "deep sawtooth": 67, "sawtal": 68, "pulse": 69, "triple pulse": 70, "high pulse": 71, "deep pulse": 72 };
            const miscWaveNames: Dictionary<number> = { "test1": 56, "pokey 4bit lfsr": 57, "pokey 5step bass": 58, "isolated spiky": 59, "unnamed 1": 60, "unnamed 2": 61, "guitar string": 75, "intense": 76, "buzz wave": 77, "pokey square": 57, "pokey bass": 58, "banana wave": 83, "test 1": 84, "test 2": 84, "real snare": 85, "earthbound o. guitar": 86 };
            const paandorasboxWaveNames: Dictionary<number> = { "kick": 87, "snare": 88, "piano1": 89, "WOW": 90, "overdrive": 91, "trumpet": 92, "saxophone": 93, "orchestrahit": 94, "detached violin": 95, "synth": 96, "sonic3snare": 97, "come on": 98, "choir": 99, "overdriveguitar": 100, "flute": 101, "legato violin": 102, "tremolo violin": 103, "amen break": 104, "pizzicato violin": 105, "tim allen grunt": 106, "tuba": 107, "loopingcymbal": 108, "standardkick": 109, "standardsnare": 110, "closedhihat": 111, "foothihat": 112, "openhihat": 113, "crashcymbal": 114, "pianoC4": 115, "liver pad": 116, "marimba": 117, "susdotwav": 118, "wackyboxtts": 119 };
            // const paandorasbetaWaveNames = {"contrabass": 55, "double bass": 56 };
            //this.chipWave = legacyWaveNames[instrumentObject["wave"]] != undefined ? legacyWaveNames[instrumentObject["wave"]] : Config.chipWaves.findIndex(wave => wave.name == instrumentObject["wave"]);
            this.chipWave = -1;
            const rawName: string = instrumentObject["wave"];
            for (const table of [
                legacyWaveNames,
                modboxWaveNames,
                sandboxWaveNames,
                zefboxWaveNames,
                miscWaveNames,
                paandorasboxWaveNames
            ]) {
                if (this.chipWave == -1 && table[rawName] != undefined && Config.chipWaves[table[rawName]] != undefined) {
                    this.chipWave = table[rawName];
                    break;
                }
            }
            if (this.chipWave == -1) {
                const potentialChipWaveIndex: number = Config.chipWaves.findIndex(wave => wave.name == rawName);
                if (potentialChipWaveIndex != -1) this.chipWave = potentialChipWaveIndex;
            }
            // this.chipWave = legacyWaveNames[instrumentObject["wave"]] != undefined ? legacyWaveNames[instrumentObject["wave"]] : modboxWaveNames[instrumentObject["wave"]] != undefined ? modboxWaveNames[instrumentObject["wave"]] : sandboxWaveNames[instrumentObject["wave"]] != undefined ? sandboxWaveNames[instrumentObject["wave"]] : zefboxWaveNames[instrumentObject["wave"]] != undefined ? zefboxWaveNames[instrumentObject["wave"]] : miscWaveNames[instrumentObject["wave"]] != undefined ? miscWaveNames[instrumentObject["wave"]] : paandorasboxWaveNames[instrumentObject["wave"]] != undefined ? paandorasboxWaveNames[instrumentObject["wave"]] : Config.chipWaves.findIndex(wave => wave.name == instrumentObject["wave"]); 
            if (this.chipWave == -1) this.chipWave = 1;
        }

        if (this.type == InstrumentType.fm || this.type == InstrumentType.fm6op) {
            if (this.type == InstrumentType.fm) {
                this.algorithm = Config.algorithms.findIndex(algorithm => algorithm.name == instrumentObject["algorithm"]);
                if (this.algorithm == -1) this.algorithm = 0;
                this.feedbackType = Config.feedbacks.findIndex(feedback => feedback.name == instrumentObject["feedbackType"]);
                if (this.feedbackType == -1) this.feedbackType = 0;
            } else {
                this.algorithm6Op = Config.algorithms6Op.findIndex(algorithm6Op => algorithm6Op.name == instrumentObject["algorithm"]);
                if (this.algorithm6Op == -1) this.algorithm6Op = 1;
                if (this.algorithm6Op == 0) {
                    this.customAlgorithm.set(instrumentObject["customAlgorithm"]["carrierCount"], instrumentObject["customAlgorithm"]["mods"]);
                } else {
                    this.customAlgorithm.fromPreset(this.algorithm6Op);
                }
                this.feedbackType6Op = Config.feedbacks6Op.findIndex(feedback6Op => feedback6Op.name == instrumentObject["feedbackType"]);
                // SynthBox feedback support
                if (this.feedbackType6Op == -1) {
                    // These are all of the SynthBox feedback presets that aren't present in Gold/UltraBox
                    let synthboxLegacyFeedbacks: DictionaryArray<any> = toNameMap([
                        { name: "2⟲ 3⟲", indices: [[], [2], [3], [], [], []] },
                        { name: "3⟲ 4⟲", indices: [[], [], [3], [4], [], []] },
                        { name: "4⟲ 5⟲", indices: [[], [], [], [4], [5], []] },
                        { name: "5⟲ 6⟲", indices: [[], [], [], [], [5], [6]] },
                        { name: "1⟲ 6⟲", indices: [[1], [], [], [], [], [6]] },
                        { name: "1⟲ 3⟲", indices: [[1], [], [3], [], [], []] },
                        { name: "1⟲ 4⟲", indices: [[1], [], [], [4], [], []] },
                        { name: "1⟲ 5⟲", indices: [[1], [], [], [], [5], []] },
                        { name: "4⟲ 6⟲", indices: [[], [], [], [4], [], [6]] },
                        { name: "2⟲ 6⟲", indices: [[], [2], [], [], [], [6]] },
                        { name: "3⟲ 6⟲", indices: [[], [], [3], [], [], [6]] },
                        { name: "4⟲ 5⟲ 6⟲", indices: [[], [], [], [4], [5], [6]] },
                        { name: "1⟲ 3⟲ 6⟲", indices: [[1], [], [3], [], [], [6]] },
                        { name: "2→5", indices: [[], [], [], [], [2], []] },
                        { name: "2→6", indices: [[], [], [], [], [], [2]] },
                        { name: "3→5", indices: [[], [], [], [], [3], []] },
                        { name: "3→6", indices: [[], [], [], [], [], [3]] },
                        { name: "4→6", indices: [[], [], [], [], [], [4]] },
                        { name: "5→6", indices: [[], [], [], [], [], [5]] },
                        { name: "1→3→4", indices: [[], [], [1], [], [3], []] },
                        { name: "2→5→6", indices: [[], [], [], [], [2], [5]] },
                        { name: "2→4→6", indices: [[], [], [], [2], [], [4]] },
                        { name: "4→5→6", indices: [[], [], [], [], [4], [5]] },
                        { name: "3→4→5→6", indices: [[], [], [], [3], [4], [5]] },
                        { name: "2→3→4→5→6", indices: [[], [1], [2], [3], [4], [5]] },
                        { name: "1→2→3→4→5→6", indices: [[], [1], [2], [3], [4], [5]] },
                    ]);

                    let synthboxFeedbackType = synthboxLegacyFeedbacks[synthboxLegacyFeedbacks.findIndex(feedback => feedback.name == instrumentObject["feedbackType"])]!.indices;

                    if (synthboxFeedbackType != undefined) {
                        this.feedbackType6Op = 0;
                        this.customFeedbackType.set(synthboxFeedbackType);
                    } else {
                        // if the feedback type STILL can't be resolved, default to the first non-custom option
                        this.feedbackType6Op = 1;
                    }
                }

                if ((this.feedbackType6Op == 0) && (instrumentObject["customFeedback"] != undefined)) {
                    this.customFeedbackType.set(instrumentObject["customFeedback"]["mods"]);
                } else {
                    this.customFeedbackType.fromPreset(this.feedbackType6Op);
                }
            }
            if (instrumentObject["feedbackAmplitude"] != undefined) {
                this.feedbackAmplitude = clamp(0, Config.operatorAmplitudeMax + 1, instrumentObject["feedbackAmplitude"] | 0);
            } else {
                this.feedbackAmplitude = 0;
            }

            for (let j: number = 0; j < Config.operatorCount + (this.type == InstrumentType.fm6op ? 2 : 0); j++) {
                const operator: Operator = this.operators[j];
                let operatorObject: any = undefined;
                if (instrumentObject["operators"] != undefined) operatorObject = instrumentObject["operators"][j];
                if (operatorObject == undefined) operatorObject = {};

                operator.frequency = Config.operatorFrequencies.findIndex(freq => freq.name == operatorObject["frequency"]);
                if (operator.frequency == -1) operator.frequency = 0;
                if (operatorObject["amplitude"] != undefined) {
                    operator.amplitude = clamp(0, Config.operatorAmplitudeMax + 1, operatorObject["amplitude"] | 0);
                } else {
                    operator.amplitude = 0;
                }
                if (operatorObject["waveform"] != undefined) {
                    // If the json is from GB, we override the last two waves to be sine to account for a bug
                    if (format == "goldbox" && j > 3) {
                        operator.waveform = 0;
                        continue;
                    }

                    operator.waveform = Config.operatorWaves.findIndex(wave => wave.name == operatorObject["waveform"]);
                    if (operator.waveform == -1) {
                        // GoldBox compatibility
                        if (operatorObject["waveform"] == "square") {
                            operator.waveform = Config.operatorWaves.dictionary["pulse width"].index;
                            operator.pulseWidth = 5;
                        } else if (operatorObject["waveform"] == "rounded") {
                            operator.waveform = Config.operatorWaves.dictionary["quasi-sine"].index;
                        } else {
                            operator.waveform = 0;
                        }

                    }
                } else {
                    operator.waveform = 0;
                }
                if (operatorObject["pulseWidth"] != undefined) {
                    operator.pulseWidth = operatorObject["pulseWidth"] | 0;
                } else {
                    operator.pulseWidth = 5;
                }
            }
        }
        else if (this.type == InstrumentType.customChipWave) {
            if (instrumentObject["customChipWave"]) {

                for (let i: number = 0; i < 64; i++) {
                    this.customChipWave[i] = instrumentObject["customChipWave"][i];
                }


                let sum: number = 0.0;
                for (let i: number = 0; i < this.customChipWave.length; i++) {
                    sum += this.customChipWave[i];
                }
                const average: number = sum / this.customChipWave.length;

                // Perform the integral on the wave. The chipSynth will perform the derivative to get the original wave back but with antialiasing.
                let cumulative: number = 0;
                let wavePrev: number = 0;
                for (let i: number = 0; i < this.customChipWave.length; i++) {
                    cumulative += wavePrev;
                    wavePrev = this.customChipWave[i] - average;
                    this.customChipWaveIntegral[i] = cumulative;
                }

                // 65th, last sample is for anti-aliasing
                this.customChipWaveIntegral[64] = 0.0;
            }
        } else if (this.type == InstrumentType.mod) {
            if (instrumentObject["modChannels"] != undefined) {
                for (let mod: number = 0; mod < Config.modCount; mod++) {
                    this.modChannels[mod] = instrumentObject["modChannels"][mod];
                    this.modInstruments[mod] = instrumentObject["modInstruments"][mod];
                    this.modulators[mod] = instrumentObject["modSettings"][mod];
                    // Due to an oversight, this isn't included in JSONs prior to JB 2.6.
                    if (instrumentObject["modFilterTypes"] != undefined)
                        this.modFilterTypes[mod] = instrumentObject["modFilterTypes"][mod];
                    if (instrumentObject["modEnvelopeNumbers"] != undefined)
                        this.modEnvelopeNumbers[mod] = instrumentObject["modEnvelopeNumbers"][mod];
                }
            }
        }

        if (this.type != InstrumentType.mod) {
            // Arpeggio speed
            if (this.chord == Config.chords.dictionary["arpeggio"].index && instrumentObject["arpeggioSpeed"] != undefined) {
                this.arpeggioSpeed = instrumentObject["arpeggioSpeed"];
            }
            else {
                this.arpeggioSpeed = (useSlowerRhythm) ? 9 : 12; // Decide whether to import arps as x3/4 speed
            }
            if (this.chord == Config.chords.dictionary["monophonic"].index && instrumentObject["monoChordTone"] != undefined) {
                this.monoChordTone = instrumentObject["monoChordTone"];
            }

            if (instrumentObject["fastTwoNoteArp"] != undefined) {
                this.fastTwoNoteArp = instrumentObject["fastTwoNoteArp"];
            }
            else {
                this.fastTwoNoteArp = useFastTwoNoteArp;
            }

            if (instrumentObject["clicklessTransition"] != undefined) {
                this.clicklessTransition = instrumentObject["clicklessTransition"];
            }
            else {
                this.clicklessTransition = false;
            }

            if (instrumentObject["aliases"] != undefined) {
                this.aliases = instrumentObject["aliases"];
            }
            else {
                // modbox had no anti-aliasing, so enable it for everything if that mode is selected
                if (format == "modbox") {
                    this.effects = (this.effects | (1 << EffectType.distortion));
                    this.aliases = true;
                    this.distortion = 0;
                } else {
                    this.aliases = false;
                }
            }

            if (instrumentObject["noteFilterType"] != undefined) {
                this.noteFilterType = instrumentObject["noteFilterType"];
            }
            if (instrumentObject["noteSimpleCut"] != undefined) {
                this.noteFilterSimpleCut = instrumentObject["noteSimpleCut"];
            }
            if (instrumentObject["noteSimplePeak"] != undefined) {
                this.noteFilterSimplePeak = instrumentObject["noteSimplePeak"];
            }
            if (instrumentObject["noteFilter"] != undefined) {
                this.noteFilter.fromJsonObject(instrumentObject["noteFilter"]);
            } else {
                this.noteFilter.reset();
            }
            for (let i: number = 0; i < Config.filterMorphCount; i++) {
                if (Array.isArray(instrumentObject["noteSubFilters" + i])) {
                    this.noteSubFilters[i] = new FilterSettings();
                    this.noteSubFilters[i]!.fromJsonObject(instrumentObject["noteSubFilters" + i]);
                }
            }
            if (instrumentObject["eqFilterType"] != undefined) {
                this.eqFilterType = instrumentObject["eqFilterType"];
            }
            if (instrumentObject["eqSimpleCut"] != undefined) {
                this.eqFilterSimpleCut = instrumentObject["eqSimpleCut"];
            }
            if (instrumentObject["eqSimplePeak"] != undefined) {
                this.eqFilterSimplePeak = instrumentObject["eqSimplePeak"];
            }
            if (Array.isArray(instrumentObject["eqFilter"])) {
                this.eqFilter.fromJsonObject(instrumentObject["eqFilter"]);
            } else {
                this.eqFilter.reset();

                const legacySettings: LegacySettings = {};

                // Try converting from legacy filter settings.
                const filterCutoffMaxHz: number = 8000;
                const filterCutoffRange: number = 11;
                const filterResonanceRange: number = 8;
                if (instrumentObject["filterCutoffHz"] != undefined) {
                    legacySettings.filterCutoff = clamp(0, filterCutoffRange, Math.round((filterCutoffRange - 1) + 2.0 * Math.log((instrumentObject["filterCutoffHz"] | 0) / filterCutoffMaxHz) / Math.LN2));
                } else {
                    legacySettings.filterCutoff = (this.type == InstrumentType.chip) ? 6 : 10;
                }
                if (instrumentObject["filterResonance"] != undefined) {
                    legacySettings.filterResonance = clamp(0, filterResonanceRange, Math.round((filterResonanceRange - 1) * (instrumentObject["filterResonance"] | 0) / 100));
                } else {
                    legacySettings.filterResonance = 0;
                }

                legacySettings.filterEnvelope = getEnvelope(instrumentObject["filterEnvelope"]);
                legacySettings.pulseEnvelope = getEnvelope(instrumentObject["pulseEnvelope"]);
                legacySettings.feedbackEnvelope = getEnvelope(instrumentObject["feedbackEnvelope"]);
                if (Array.isArray(instrumentObject["operators"])) {
                    legacySettings.operatorEnvelopes = [];
                    for (let j: number = 0; j < Config.operatorCount + (this.type == InstrumentType.fm6op ? 2 : 0); j++) {
                        let envelope: Envelope | undefined;
                        if (instrumentObject["operators"][j] != undefined) {
                            envelope = getEnvelope(instrumentObject["operators"][j]["envelope"]);
                        }
                        legacySettings.operatorEnvelopes[j] = (envelope != undefined) ? envelope : Config.envelopes.dictionary["none"];
                    }
                }

                // Try converting from even older legacy filter settings.
                if (instrumentObject["filter"] != undefined) {
                    const legacyToCutoff: number[] = [10, 6, 3, 0, 8, 5, 2];
                    const legacyToEnvelope: string[] = ["none", "none", "none", "none", "decay 1", "decay 2", "decay 3"];
                    const filterNames: string[] = ["none", "bright", "medium", "soft", "decay bright", "decay medium", "decay soft"];
                    const oldFilterNames: Dictionary<number> = { "sustain sharp": 1, "sustain medium": 2, "sustain soft": 3, "decay sharp": 4 };
                    let legacyFilter: number = oldFilterNames[instrumentObject["filter"]] != undefined ? oldFilterNames[instrumentObject["filter"]] : filterNames.indexOf(instrumentObject["filter"]);
                    if (legacyFilter == -1) legacyFilter = 0;
                    legacySettings.filterCutoff = legacyToCutoff[legacyFilter];
                    legacySettings.filterEnvelope = getEnvelope(legacyToEnvelope[legacyFilter]);
                    legacySettings.filterResonance = 0;
                }

                this.convertLegacySettings(legacySettings, true);
            }

            for (let i: number = 0; i < Config.filterMorphCount; i++) {
                if (Array.isArray(instrumentObject["eqSubFilters" + i])) {
                    this.eqSubFilters[i] = new FilterSettings();
                    this.eqSubFilters[i]!.fromJsonObject(instrumentObject["eqSubFilters" + i]);
                }
            }

            if (Array.isArray(instrumentObject["envelopes"])) {
                const envelopeArray: any[] = instrumentObject["envelopes"];
                for (let i = 0; i < envelopeArray.length; i++) {
                    if (this.envelopeCount >= Config.maxEnvelopeCount) break;
                    const tempEnvelope: EnvelopeSettings = new EnvelopeSettings(this.isNoiseInstrument);
                    tempEnvelope.fromJsonObject(envelopeArray[i], format);
                    //old pitch envelope detection
                    let pitchEnvelopeStart: number;
                    if (instrumentObject["pitchEnvelopeStart"] != undefined && instrumentObject["pitchEnvelopeStart"] != null) { //make sure is not null bc for some reason it can be
                        pitchEnvelopeStart = instrumentObject["pitchEnvelopeStart"];
                    } else if (instrumentObject["pitchEnvelopeStart" + i] != undefined && instrumentObject["pitchEnvelopeStart" + i] != undefined) {
                        pitchEnvelopeStart = instrumentObject["pitchEnvelopeStart" + i];
                    } else {
                        pitchEnvelopeStart = tempEnvelope.pitchEnvelopeStart;
                    }
                    let pitchEnvelopeEnd: number;
                    if (instrumentObject["pitchEnvelopeEnd"] != undefined && instrumentObject["pitchEnvelopeEnd"] != null) {
                        pitchEnvelopeEnd = instrumentObject["pitchEnvelopeEnd"];
                    } else if (instrumentObject["pitchEnvelopeEnd" + i] != undefined && instrumentObject["pitchEnvelopeEnd" + i] != null) {
                        pitchEnvelopeEnd = instrumentObject["pitchEnvelopeEnd" + i];
                    } else {
                        pitchEnvelopeEnd = tempEnvelope.pitchEnvelopeEnd;
                    }
                    let envelopeInverse: boolean;
                    if (instrumentObject["envelopeInverse" + i] != undefined && instrumentObject["envelopeInverse" + i] != null) {
                        envelopeInverse = instrumentObject["envelopeInverse" + i];
                    } else if (instrumentObject["pitchEnvelopeInverse"] != undefined && instrumentObject["pitchEnvelopeInverse"] != null && Config.envelopes[tempEnvelope.envelope].name == "pitch") { //assign only if a pitch envelope
                        envelopeInverse = instrumentObject["pitchEnvelopeInverse"];
                    } else {
                        envelopeInverse = tempEnvelope.inverse;
                    }
                    let discreteEnvelope: boolean;
                    if (instrumentObject["discreteEnvelope"] != undefined) {
                        discreteEnvelope = instrumentObject["discreteEnvelope"];
                    } else {
                        discreteEnvelope = tempEnvelope.discrete;
                    }
                    this.addEnvelope(tempEnvelope.target, tempEnvelope.index, tempEnvelope.envelope, true, pitchEnvelopeStart, pitchEnvelopeEnd, envelopeInverse, tempEnvelope.perEnvelopeSpeed, tempEnvelope.perEnvelopeLowerBound, tempEnvelope.perEnvelopeUpperBound, tempEnvelope.steps, tempEnvelope.seed, tempEnvelope.waveform, discreteEnvelope);
                }
            }
        }
        // advloop addition
        if (type === 0) {
            if (instrumentObject["isUsingAdvancedLoopControls"] != undefined) {
                this.isUsingAdvancedLoopControls = instrumentObject["isUsingAdvancedLoopControls"];
                this.chipWaveLoopStart = instrumentObject["chipWaveLoopStart"];
                this.chipWaveLoopEnd = instrumentObject["chipWaveLoopEnd"];
                this.chipWaveLoopMode = instrumentObject["chipWaveLoopMode"];
                this.chipWavePlayBackwards = instrumentObject["chipWavePlayBackwards"];
                this.chipWaveStartOffset = instrumentObject["chipWaveStartOffset"];
            } else {
                this.isUsingAdvancedLoopControls = false;
                this.chipWaveLoopStart = 0;
                this.chipWaveLoopEnd = Config.rawRawChipWaves[this.chipWave].samples.length - 1;
                this.chipWaveLoopMode = 0;
                this.chipWavePlayBackwards = false;
                this.chipWaveStartOffset = 0;
            }
        }
    }
    // advloop addition

    public getLargestControlPointCount(forNoteFilter: boolean) {
        let largest: number;
        if (forNoteFilter) {
            largest = this.noteFilter.controlPointCount;
            for (let i: number = 0; i < Config.filterMorphCount; i++) {
                if (this.noteSubFilters[i] != null && this.noteSubFilters[i]!.controlPointCount > largest)
                    largest = this.noteSubFilters[i]!.controlPointCount;
            }
        }
        else {
            largest = this.eqFilter.controlPointCount;
            for (let i: number = 0; i < Config.filterMorphCount; i++) {
                if (this.eqSubFilters[i] != null && this.eqSubFilters[i]!.controlPointCount > largest)
                    largest = this.eqSubFilters[i]!.controlPointCount;
            }
        }
        return largest;
    }

    public static frequencyFromPitch(pitch: number): number {
        return 440.0 * Math.pow(2.0, (pitch - 69.0) / 12.0);
    }

    public addEnvelope(target: number, index: number, envelope: number, newEnvelopes: boolean, start: number = 0, end: number = -1, inverse: boolean = false, perEnvelopeSpeed: number = -1, perEnvelopeLowerBound: number = 0, perEnvelopeUpperBound: number = 1, steps: number = 2, seed: number = 2, waveform: number = LFOEnvelopeTypes.sine, discrete: boolean = false): void {
        end = end != -1 ? end : this.isNoiseInstrument ? Config.drumCount - 1 : Config.maxPitch; //find default if none is given
        perEnvelopeSpeed = perEnvelopeSpeed != -1 ? perEnvelopeSpeed : newEnvelopes ? 1 : Config.envelopes[envelope].speed; //find default if none is given
        let makeEmpty: boolean = false;
        if (!this.supportsEnvelopeTarget(target, index)) makeEmpty = true;
        if (this.envelopeCount >= Config.maxEnvelopeCount) throw new Error();
        while (this.envelopes.length <= this.envelopeCount) this.envelopes[this.envelopes.length] = new EnvelopeSettings(this.isNoiseInstrument);
        const envelopeSettings: EnvelopeSettings = this.envelopes[this.envelopeCount];
        envelopeSettings.target = makeEmpty ? Config.instrumentAutomationTargets.dictionary["none"].index : target;
        envelopeSettings.index = makeEmpty ? 0 : index;
        if (!newEnvelopes) {
            envelopeSettings.envelope = clamp(0, Config.newEnvelopes.length, Config.envelopes[envelope].type);
        } else {
            envelopeSettings.envelope = envelope;
        }
        envelopeSettings.pitchEnvelopeStart = start;
        envelopeSettings.pitchEnvelopeEnd = end;
        envelopeSettings.inverse = inverse;
        envelopeSettings.perEnvelopeSpeed = perEnvelopeSpeed;
        envelopeSettings.perEnvelopeLowerBound = perEnvelopeLowerBound;
        envelopeSettings.perEnvelopeUpperBound = perEnvelopeUpperBound;
        envelopeSettings.steps = steps;
        envelopeSettings.seed = seed;
        envelopeSettings.waveform = waveform;
        envelopeSettings.discrete = discrete;
        this.envelopeCount++;
    }

    public supportsEnvelopeTarget(target: number, index: number): boolean {
        const automationTarget: AutomationTarget = Config.instrumentAutomationTargets[target];
        if (automationTarget.computeIndex == null && automationTarget.name != "none") {
            return false;
        }
        if (index >= automationTarget.maxCount) {
            return false;
        }
        if (automationTarget.compatibleInstruments != null && automationTarget.compatibleInstruments.indexOf(this.type) == -1) {
            return false;
        }
        if (automationTarget.effect != null && (this.effects & (1 << automationTarget.effect)) == 0) {
            return false;
        }
        if (automationTarget.name == "arpeggioSpeed") {
            return effectsIncludeChord(this.effects) && this.chord == Config.chords.dictionary["arpeggio"].index;
        }
        if (automationTarget.isFilter) {
            //if (automationTarget.perNote) {
            let useControlPointCount: number = this.noteFilter.controlPointCount;
            if (this.noteFilterType)
                useControlPointCount = 1;
            if (index >= useControlPointCount) return false;
            //} else {
            //	if (index >= this.eqFilter.controlPointCount)   return false;
            //}
        }
        if ((automationTarget.name == "operatorFrequency") || (automationTarget.name == "operatorAmplitude")) {
            if (index >= 4 + (this.type == InstrumentType.fm6op ? 2 : 0)) return false;
        }
        return true;
    }

    public clearInvalidEnvelopeTargets(): void {
        for (let envelopeIndex: number = 0; envelopeIndex < this.envelopeCount; envelopeIndex++) {
            const target: number = this.envelopes[envelopeIndex].target;
            const index: number = this.envelopes[envelopeIndex].index;
            if (!this.supportsEnvelopeTarget(target, index)) {
                this.envelopes[envelopeIndex].target = Config.instrumentAutomationTargets.dictionary["none"].index;
                this.envelopes[envelopeIndex].index = 0;
            }
        }
    }

    public getTransition(): Transition {
        return effectsIncludeTransition(this.effects) ? Config.transitions[this.transition] :
            (this.type == InstrumentType.mod ? Config.transitions.dictionary["interrupt"] : Config.transitions.dictionary["normal"]);
    }

    public getFadeInSeconds(): number {
        return (this.type == InstrumentType.drumset) ? 0.0 : Synth.fadeInSettingToSeconds(this.fadeIn);
    }

    public getFadeOutTicks(): number {
        return (this.type == InstrumentType.drumset) ? Config.drumsetFadeOutTicks : Synth.fadeOutSettingToTicks(this.fadeOut)
    }

    public getChord(): Chord {
        return effectsIncludeChord(this.effects) ? Config.chords[this.chord] : Config.chords.dictionary["simultaneous"];
    }

    public getDrumsetEnvelope(pitch: number): Envelope {
        if (this.type != InstrumentType.drumset) throw new Error("Can't getDrumsetEnvelope() for non-drumset.");
        return Config.envelopes[this.drumsetEnvelopes[pitch]];
    }
}

export class Channel {
    public octave: number = 0;
    public readonly instruments: Instrument[] = [];
    public readonly patterns: Pattern[] = [];
    public readonly bars: number[] = [];
    public muted: boolean = false;
    public name: string = "";
}

export class Song {
    private static readonly _format: string = Config.jsonFormat;
    private static readonly _oldestBeepboxVersion: number = 2;
    private static readonly _latestBeepboxVersion: number = 9;
    private static readonly _oldestJummBoxVersion: number = 1;
    private static readonly _latestJummBoxVersion: number = 6;
    private static readonly _oldestGoldBoxVersion: number = 1;
    private static readonly _latestGoldBoxVersion: number = 4;
    private static readonly _oldestUltraBoxVersion: number = 1;
    private static readonly _latestUltraBoxVersion: number = 5;
    private static readonly _oldestSlarmoosBoxVersion: number = 1;
    private static readonly _latestSlarmoosBoxVersion: number = 5;
    private static readonly _oldestJukeBoxVersion: number = 1;
    private static readonly _latestJukeBoxVersion: number = 5;
    // One-character variant detection at the start of URL to distinguish variants such as JummBox, Or Goldbox. "j" and "g" respectively
    //also "u" is ultrabox lol
    // private static readonly _variant = 0x73; //"S" - Slarmoo's Box
    private static readonly _variant = 0x4a; //"J" is for JukeBox

    public title: string;
    public scale: number;
    public scaleCustom: boolean[] = [];
    public key: number;
    public octave: number;
    public tempo: number;
    public reverb: number;
    public beatsPerBar: number;
    public barCount: number;
    public patternsPerChannel: number;
    public rhythm: number;
    public layeredInstruments: boolean;
    public patternInstruments: boolean;
    public loopStart: number;
    public loopLength: number;
    public pitchChannelCount: number;
    public noiseChannelCount: number;
    public modChannelCount: number;
    public readonly channels: Channel[] = [];
    public limitDecay: number = 4.0;
    public limitRise: number = 4000.0;
    public compressionThreshold: number = 1.0;
    public limitThreshold: number = 1.0;
    public compressionRatio: number = 1.0;
    public limitRatio: number = 1.0;
    public masterGain: number = 1.0;
    public inVolumeCap: number = 0.0;
    public outVolumeCap: number = 0.0;
    public eqFilter: FilterSettings = new FilterSettings();
    public eqFilterType: boolean = false;
    public eqFilterSimpleCut: number = Config.filterSimpleCutRange - 1;
    public eqFilterSimplePeak: number = 0;
    public eqSubFilters: (FilterSettings | null)[] = [];
    public tmpEqFilterStart: FilterSettings | null;
    public tmpEqFilterEnd: FilterSettings | null;

    constructor(string?: string) {
        if (string != undefined) {
            this.fromBase64String(string);
        } else {
            this.initToDefault(true);
        }
    }

    // Returns the ideal new note volume when dragging (max volume for a normal note, a "neutral" value for mod notes based on how they work)
    public getNewNoteVolume = (isMod: boolean, modChannel?: number, modInstrument?: number, modCount?: number): number => {
        if (!isMod || modChannel == undefined || modInstrument == undefined || modCount == undefined)
            return Config.noteSizeMax;
        else {
            // Sigh, the way pitches count up and the visual ordering in the UI are flipped.
            modCount = Config.modCount - modCount - 1;

            const instrument: Instrument = this.channels[modChannel].instruments[modInstrument];
            let vol: number | undefined = Config.modulators[instrument.modulators[modCount]].newNoteVol;

            let currentIndex: number = instrument.modulators[modCount];
            // For tempo, actually use user defined tempo
            let tempoIndex: number = Config.modulators.dictionary["tempo"].index;
            if (currentIndex == tempoIndex) vol = this.tempo - Config.modulators[tempoIndex].convertRealFactor;
            //for effects and envelopes, use the user defined value of the selected instrument (or the default value if all or active is selected)
            if (!Config.modulators[currentIndex].forSong && instrument.modInstruments[modCount] < this.channels[instrument.modChannels[modCount]].instruments.length) {
                let chorusIndex: number = Config.modulators.dictionary["chorus"].index;
                let reverbIndex: number = Config.modulators.dictionary["reverb"].index;
                let panningIndex: number = Config.modulators.dictionary["pan"].index;
                let panDelayIndex: number = Config.modulators.dictionary["pan delay"].index;
                let distortionIndex: number = Config.modulators.dictionary["distortion"].index;
                let detuneIndex: number = Config.modulators.dictionary["detune"].index;
                let vibratoDepthIndex: number = Config.modulators.dictionary["vibrato depth"].index;
                let vibratoSpeedIndex: number = Config.modulators.dictionary["vibrato speed"].index;
                let vibratoDelayIndex: number = Config.modulators.dictionary["vibrato delay"].index;
                let arpSpeedIndex: number = Config.modulators.dictionary["arp speed"].index;
                let bitCrushIndex: number = Config.modulators.dictionary["bit crush"].index;
                let freqCrushIndex: number = Config.modulators.dictionary["freq crush"].index;
                let echoIndex: number = Config.modulators.dictionary["echo"].index;
                let echoDelayIndex: number = Config.modulators.dictionary["echo delay"].index;
                let pitchShiftIndex: number = Config.modulators.dictionary["pitch shift"].index;
                let ringModIndex: number = Config.modulators.dictionary["ring modulation"].index;
                let ringModHertzIndex: number = Config.modulators.dictionary["ring mod hertz"].index;
                let granularIndex: number = Config.modulators.dictionary["granular"].index;
                let grainAmountIndex: number = Config.modulators.dictionary["grain freq"].index;
                let grainSizeIndex: number = Config.modulators.dictionary["grain size"].index;
                let grainRangeIndex: number = Config.modulators.dictionary["grain range"].index;
                let envSpeedIndex: number = Config.modulators.dictionary["envelope speed"].index;
                let perEnvSpeedIndex: number = Config.modulators.dictionary["individual envelope speed"].index;
                let perEnvLowerIndex: number = Config.modulators.dictionary["individual envelope lower bound"].index;
                let perEnvUpperIndex: number = Config.modulators.dictionary["individual envelope upper bound"].index;
                let instrumentIndex: number = instrument.modInstruments[modCount];

                switch (currentIndex) {
                    case chorusIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].chorus - Config.modulators[chorusIndex].convertRealFactor;
                        break;
                    case reverbIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].reverb - Config.modulators[reverbIndex].convertRealFactor;
                        break;
                    case panningIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].pan - Config.modulators[panningIndex].convertRealFactor;
                        break;
                    case panDelayIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].panDelay - Config.modulators[panDelayIndex].convertRealFactor;
                        break;
                    case distortionIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].distortion - Config.modulators[distortionIndex].convertRealFactor;
                        break;
                    case detuneIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].detune;
                        break;
                    case vibratoDepthIndex:
                        vol = Math.round(this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].vibratoDepth * 25 - Config.modulators[vibratoDepthIndex].convertRealFactor);
                        break;
                    case vibratoSpeedIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].vibratoSpeed - Config.modulators[vibratoSpeedIndex].convertRealFactor;
                        break;
                    case vibratoDelayIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].vibratoDelay - Config.modulators[vibratoDelayIndex].convertRealFactor;
                        break;
                    case arpSpeedIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].arpeggioSpeed - Config.modulators[arpSpeedIndex].convertRealFactor;
                        break;
                    case bitCrushIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].bitcrusherQuantization - Config.modulators[bitCrushIndex].convertRealFactor;
                        break;
                    case freqCrushIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].bitcrusherFreq - Config.modulators[freqCrushIndex].convertRealFactor;
                        break;
                    case echoIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].echoSustain - Config.modulators[echoIndex].convertRealFactor;
                        break;
                    case echoDelayIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].echoDelay - Config.modulators[echoDelayIndex].convertRealFactor;
                        break;
                    case pitchShiftIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].pitchShift;
                        break;
                    case ringModIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].ringModulation - Config.modulators[ringModIndex].convertRealFactor;
                        break;
                    case ringModHertzIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].ringModulationHz - Config.modulators[ringModHertzIndex].convertRealFactor;
                        break;
                    case granularIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].granular - Config.modulators[granularIndex].convertRealFactor;
                        break;
                    case grainAmountIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].grainAmounts - Config.modulators[grainAmountIndex].convertRealFactor;
                        break;
                    case grainSizeIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].grainSize - Config.modulators[grainSizeIndex].convertRealFactor;
                        break;
                    case grainRangeIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].grainRange - Config.modulators[grainRangeIndex].convertRealFactor;
                        break;
                    case envSpeedIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].envelopeSpeed - Config.modulators[envSpeedIndex].convertRealFactor;
                        break;
                    case perEnvSpeedIndex:
                        vol = Config.perEnvelopeSpeedToIndices[this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].envelopes[instrument.modEnvelopeNumbers[modCount]].perEnvelopeSpeed] - Config.modulators[perEnvSpeedIndex].convertRealFactor;
                        break;
                    case perEnvLowerIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].envelopes[instrument.modEnvelopeNumbers[modCount]].perEnvelopeLowerBound * 10 - Config.modulators[perEnvLowerIndex].convertRealFactor;
                        break;
                    case perEnvUpperIndex:
                        vol = this.channels[instrument.modChannels[modCount]].instruments[instrumentIndex].envelopes[instrument.modEnvelopeNumbers[modCount]].perEnvelopeUpperBound * 10 - Config.modulators[perEnvUpperIndex].convertRealFactor;
                        break;
                }
            }

            if (vol != undefined)
                return vol;
            else
                return Config.noteSizeMax;
        }
    }


    public getVolumeCap = (isMod: boolean, modChannel?: number, modInstrument?: number, modCount?: number): number => {
        if (!isMod || modChannel == undefined || modInstrument == undefined || modCount == undefined)
            return Config.noteSizeMax;
        else {
            // Sigh, the way pitches count up and the visual ordering in the UI are flipped.
            modCount = Config.modCount - modCount - 1;

            let instrument: Instrument = this.channels[modChannel].instruments[modInstrument];
            let modulator = Config.modulators[instrument.modulators[modCount]];
            let cap: number | undefined = modulator.maxRawVol;

            if (cap != undefined) {
                // For filters, cap is dependent on which filter setting is targeted
                if (modulator.name == "eq filter" || modulator.name == "note filter" || modulator.name == "song eq") {
                    // type 0: number of filter morphs
                    // type 1/odd: number of filter x positions
                    // type 2/even: number of filter y positions
                    cap = Config.filterMorphCount - 1;
                    if (instrument.modFilterTypes[modCount] > 0 && instrument.modFilterTypes[modCount] % 2) {
                        cap = Config.filterFreqRange;
                    } else if (instrument.modFilterTypes[modCount] > 0) {
                        cap = Config.filterGainRange;
                    }
                }
                return cap;
            }
            else
                return Config.noteSizeMax;
        }
    }

    public getVolumeCapForSetting = (isMod: boolean, modSetting: number, filterType?: number): number => {
        if (!isMod)
            return Config.noteSizeMax;
        else {
            let cap: number | undefined = Config.modulators[modSetting].maxRawVol;
            if (cap != undefined) {

                // For filters, cap is dependent on which filter setting is targeted
                if (filterType != undefined && (Config.modulators[modSetting].name == "eq filter" || Config.modulators[modSetting].name == "note filter" || Config.modulators[modSetting].name == "song eq")) {
                    // type 0: number of filter morphs
                    // type 1/odd: number of filter x positions
                    // type 2/even: number of filter y positions
                    cap = Config.filterMorphCount - 1;
                    if (filterType > 0 && filterType % 2) {
                        cap = Config.filterFreqRange;
                    } else if (filterType > 0) {
                        cap = Config.filterGainRange;
                    }
                }

                return cap;
            } else
                return Config.noteSizeMax;
        }
    }

    public getChannelCount(): number {
        return this.pitchChannelCount + this.noiseChannelCount + this.modChannelCount;
    }

    public getMaxInstrumentsPerChannel(): number {
        return Math.max(
            this.layeredInstruments ? Config.layeredInstrumentCountMax : Config.instrumentCountMin,
            this.patternInstruments ? Config.patternInstrumentCountMax : Config.instrumentCountMin);
    }

    public getMaxInstrumentsPerPattern(channelIndex: number): number {
        return this.getMaxInstrumentsPerPatternForChannel(this.channels[channelIndex]);
    }

    public getMaxInstrumentsPerPatternForChannel(channel: Channel): number {
        return this.layeredInstruments
            ? Math.min(Config.layeredInstrumentCountMax, channel.instruments.length)
            : 1;
    }

    public getChannelIsNoise(channelIndex: number): boolean {
        return (channelIndex >= this.pitchChannelCount && channelIndex < this.pitchChannelCount + this.noiseChannelCount);
    }

    public getChannelIsMod(channelIndex: number): boolean {
        return (channelIndex >= this.pitchChannelCount + this.noiseChannelCount);
    }

    public initToDefault(andResetChannels: boolean = true): void {
        this.scale = 0;
        this.scaleCustom = [true, false, false, false, false, false, false, false, false, false, false, false];
        //this.scaleCustom = [true, false, true, true, false, false, false, true, true, false, true, true];
        //this.scaleCustom = [true, false, false, false, false, false, false, false, false, false, false, false];
        this.key = 0;
        this.octave = 0;
        this.loopStart = 0;
        this.loopLength = 4;
        this.tempo = 150; //Default tempo returned to 150 for consistency with BeepBox and JummBox
        this.reverb = 0;
        this.beatsPerBar = 8;
        this.barCount = 16;
        this.patternsPerChannel = 8;
        this.rhythm = 1;
        this.layeredInstruments = false;
        this.patternInstruments = false;
        this.eqFilter.reset();
        for (let i: number = 0; i < Config.filterMorphCount - 1; i++) {
            this.eqSubFilters[i] = null;
        }

        //This is the tab's display name
        this.title = "Untitled";
        document.title = this.title + " - " + EditorConfig.versionDisplayName;
        if (andResetChannels) {
            this.pitchChannelCount = 5; //Slarmoo's Box: 3
            this.noiseChannelCount = 1;
            this.modChannelCount = 1;
            for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                const isNoiseChannel: boolean = channelIndex >= this.pitchChannelCount && channelIndex < this.pitchChannelCount + this.noiseChannelCount;
                const isModChannel: boolean = channelIndex >= this.pitchChannelCount + this.noiseChannelCount;
                if (this.channels.length <= channelIndex) {
                    this.channels[channelIndex] = new Channel();
                }
                const channel: Channel = this.channels[channelIndex];
                channel.octave = Math.max(3 - channelIndex, 0); // [3, 2, 1, 0]; Descending octaves with drums at zero in last channel.

                for (let pattern: number = 0; pattern < this.patternsPerChannel; pattern++) {
                    if (channel.patterns.length <= pattern) {
                        channel.patterns[pattern] = new Pattern();
                    } else {
                        channel.patterns[pattern].reset();
                    }
                }
                channel.patterns.length = this.patternsPerChannel;

                for (let instrument: number = 0; instrument < Config.instrumentCountMin; instrument++) {
                    if (channel.instruments.length <= instrument) {
                        channel.instruments[instrument] = new Instrument(isNoiseChannel, isModChannel);
                    }
                    channel.instruments[instrument].setTypeAndReset(isModChannel ? InstrumentType.mod : (isNoiseChannel ? InstrumentType.noise : InstrumentType.chip), isNoiseChannel, isModChannel);
                }
                channel.instruments.length = Config.instrumentCountMin;

                for (let bar: number = 0; bar < this.barCount; bar++) {
                    channel.bars[bar] = bar < 4 ? 1 : 0;
                }
                channel.bars.length = this.barCount;
            }
            this.channels.length = this.getChannelCount();
        }
    }

    //This determines the url
    public toBase64String(): string {
        let bits: BitFieldWriter;
        let buffer: number[] = [];

        buffer.push(Song._variant);
        buffer.push(base64IntToCharCode[Song._latestJukeBoxVersion]);

        // Length of the song name string
        buffer.push(SongTagCode.songTitle);
        var encodedSongTitle: string = encodeURIComponent(this.title);
        buffer.push(base64IntToCharCode[encodedSongTitle.length >> 6], base64IntToCharCode[encodedSongTitle.length & 0x3f]);

        // Actual encoded string follows
        for (let i: number = 0; i < encodedSongTitle.length; i++) {
            buffer.push(encodedSongTitle.charCodeAt(i));
        }

        buffer.push(SongTagCode.channelCount, base64IntToCharCode[this.pitchChannelCount], base64IntToCharCode[this.noiseChannelCount], base64IntToCharCode[this.modChannelCount]);
        buffer.push(SongTagCode.scale, base64IntToCharCode[this.scale]);
        if (this.scale == Config.scales["dictionary"]["Custom"].index) {
            for (var i = 1; i < Config.pitchesPerOctave; i++) {
                buffer.push(base64IntToCharCode[this.scaleCustom[i] ? 1 : 0]) // ineffiecent? yes, all we're going to do for now? hell yes
            }
        }
        buffer.push(SongTagCode.key, base64IntToCharCode[this.key], base64IntToCharCode[this.octave - Config.octaveMin]);
        buffer.push(SongTagCode.loopStart, base64IntToCharCode[this.loopStart >> 6], base64IntToCharCode[this.loopStart & 0x3f]);
        buffer.push(SongTagCode.loopEnd, base64IntToCharCode[(this.loopLength - 1) >> 6], base64IntToCharCode[(this.loopLength - 1) & 0x3f]);
        buffer.push(SongTagCode.tempo, base64IntToCharCode[this.tempo >> 6], base64IntToCharCode[this.tempo & 0x3F]);
        buffer.push(SongTagCode.beatCount, base64IntToCharCode[this.beatsPerBar - 1]);
        buffer.push(SongTagCode.barCount, base64IntToCharCode[(this.barCount - 1) >> 6], base64IntToCharCode[(this.barCount - 1) & 0x3f]);
        buffer.push(SongTagCode.patternCount, base64IntToCharCode[(this.patternsPerChannel - 1) >> 6], base64IntToCharCode[(this.patternsPerChannel - 1) & 0x3f]);
        buffer.push(SongTagCode.rhythm, base64IntToCharCode[this.rhythm]);

        // Push limiter settings, but only if they aren't the default!
        buffer.push(SongTagCode.limiterSettings);
        if (this.compressionRatio != 1.0 || this.limitRatio != 1.0 || this.limitRise != 4000.0 || this.limitDecay != 4.0 || this.limitThreshold != 1.0 || this.compressionThreshold != 1.0 || this.masterGain != 1.0) {
            buffer.push(base64IntToCharCode[Math.round(this.compressionRatio < 1 ? this.compressionRatio * 10 : 10 + (this.compressionRatio - 1) * 60)]); // 0 ~ 1.15 uneven, mapped to 0 ~ 20
            buffer.push(base64IntToCharCode[Math.round(this.limitRatio < 1 ? this.limitRatio * 10 : 9 + this.limitRatio)]); // 0 ~ 10 uneven, mapped to 0 ~ 20
            buffer.push(base64IntToCharCode[this.limitDecay]); // directly 1 ~ 30
            buffer.push(base64IntToCharCode[Math.round((this.limitRise - 2000.0) / 250.0)]); // 2000 ~ 10000 by 250, mapped to 0 ~ 32
            buffer.push(base64IntToCharCode[Math.round(this.compressionThreshold * 20)]); // 0 ~ 1.1 by 0.05, mapped to 0 ~ 22
            buffer.push(base64IntToCharCode[Math.round(this.limitThreshold * 20)]); // 0 ~ 2 by 0.05, mapped to 0 ~ 40
            buffer.push(base64IntToCharCode[Math.round(this.masterGain * 50) >> 6], base64IntToCharCode[Math.round(this.masterGain * 50) & 0x3f]); // 0 ~ 5 by 0.02, mapped to 0 ~ 250
        }
        else {
            buffer.push(base64IntToCharCode[0x3f]); // Not using limiter
        }

        //songeq
        buffer.push(SongTagCode.songEq);
        if (this.eqFilter == null) {
            // Push null filter settings
            buffer.push(base64IntToCharCode[0]);
            console.log("Null EQ filter settings detected in toBase64String for song");
        } else {
            buffer.push(base64IntToCharCode[this.eqFilter.controlPointCount]);
            for (let j: number = 0; j < this.eqFilter.controlPointCount; j++) {
                const point: FilterControlPoint = this.eqFilter.controlPoints[j];
                buffer.push(base64IntToCharCode[point.type], base64IntToCharCode[Math.round(point.freq)], base64IntToCharCode[Math.round(point.gain)]);
            }
        }

        // Push subfilters as well. Skip Index 0, is a copy of the base filter.
        let usingSubFilterBitfield: number = 0;
        for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
            usingSubFilterBitfield |= (+(this.eqSubFilters[j + 1] != null) << j);
        }
        // Put subfilter usage into 2 chars (12 bits)
        buffer.push(base64IntToCharCode[usingSubFilterBitfield >> 6], base64IntToCharCode[usingSubFilterBitfield & 63]);
        // Put subfilter info in for all used subfilters
        for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
            if (usingSubFilterBitfield & (1 << j)) {
                buffer.push(base64IntToCharCode[this.eqSubFilters[j + 1]!.controlPointCount]);
                for (let k: number = 0; k < this.eqSubFilters[j + 1]!.controlPointCount; k++) {
                    const point: FilterControlPoint = this.eqSubFilters[j + 1]!.controlPoints[k];
                    buffer.push(base64IntToCharCode[point.type], base64IntToCharCode[Math.round(point.freq)], base64IntToCharCode[Math.round(point.gain)]);
                }
            }
        }

        buffer.push(SongTagCode.channelNames);
        for (let channel: number = 0; channel < this.getChannelCount(); channel++) {
            // Length of the channel name string
            var encodedChannelName: string = encodeURIComponent(this.channels[channel].name);
            buffer.push(base64IntToCharCode[encodedChannelName.length >> 6], base64IntToCharCode[encodedChannelName.length & 0x3f]);

            // Actual encoded string follows
            for (let i: number = 0; i < encodedChannelName.length; i++) {
                buffer.push(encodedChannelName.charCodeAt(i));
            }
        }

        buffer.push(SongTagCode.instrumentCount, base64IntToCharCode[(<any>this.layeredInstruments << 1) | <any>this.patternInstruments]);
        if (this.layeredInstruments || this.patternInstruments) {
            for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                buffer.push(base64IntToCharCode[this.channels[channelIndex].instruments.length - Config.instrumentCountMin]);
            }
        }

        buffer.push(SongTagCode.channelOctave);
        for (let channelIndex: number = 0; channelIndex < this.pitchChannelCount; channelIndex++) {
            buffer.push(base64IntToCharCode[this.channels[channelIndex].octave]);
        }

        //This is for specific instrument stuff to url
        for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
            for (let i: number = 0; i < this.channels[channelIndex].instruments.length; i++) {
                const instrument: Instrument = this.channels[channelIndex].instruments[i];
                buffer.push(SongTagCode.startInstrument, base64IntToCharCode[instrument.type]);
                buffer.push(SongTagCode.volume, base64IntToCharCode[(instrument.volume + Config.volumeRange / 2) >> 6], base64IntToCharCode[(instrument.volume + Config.volumeRange / 2) & 0x3f]);
                buffer.push(SongTagCode.preset, base64IntToCharCode[instrument.preset >> 18], base64IntToCharCode[(instrument.preset >> 12) & 63], base64IntToCharCode[(instrument.preset >> 6) & 63], base64IntToCharCode[instrument.preset & 63]);
                //debug
                buffer.push(SongTagCode.eqFilter);
                buffer.push(base64IntToCharCode[+instrument.eqFilterType]);
                if (instrument.eqFilterType) {
                    buffer.push(base64IntToCharCode[instrument.eqFilterSimpleCut]);
                    buffer.push(base64IntToCharCode[instrument.eqFilterSimplePeak]);
                }
                else {
                    if (instrument.eqFilter == null) {
                        // Push null filter settings
                        buffer.push(base64IntToCharCode[0]);
                        console.log("Null EQ filter settings detected in toBase64String for channelIndex " + channelIndex + ", instrumentIndex " + i);
                    } else {
                        buffer.push(base64IntToCharCode[instrument.eqFilter.controlPointCount]);
                        for (let j: number = 0; j < instrument.eqFilter.controlPointCount; j++) {
                            const point: FilterControlPoint = instrument.eqFilter.controlPoints[j];
                            buffer.push(base64IntToCharCode[point.type], base64IntToCharCode[Math.round(point.freq)], base64IntToCharCode[Math.round(point.gain)]);
                        }
                    }

                    // Push subfilters as well. Skip Index 0, is a copy of the base filter.
                    let usingSubFilterBitfield: number = 0;
                    for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
                        usingSubFilterBitfield |= (+(instrument.eqSubFilters[j + 1] != null) << j);
                    }
                    // Put subfilter usage into 2 chars (12 bits)
                    buffer.push(base64IntToCharCode[usingSubFilterBitfield >> 6], base64IntToCharCode[usingSubFilterBitfield & 63]);
                    // Put subfilter info in for all used subfilters
                    for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
                        if (usingSubFilterBitfield & (1 << j)) {
                            buffer.push(base64IntToCharCode[instrument.eqSubFilters[j + 1]!.controlPointCount]);
                            for (let k: number = 0; k < instrument.eqSubFilters[j + 1]!.controlPointCount; k++) {
                                const point: FilterControlPoint = instrument.eqSubFilters[j + 1]!.controlPoints[k];
                                buffer.push(base64IntToCharCode[point.type], base64IntToCharCode[Math.round(point.freq)], base64IntToCharCode[Math.round(point.gain)]);
                            }
                        }
                    }
                }

                // The list of enabled effects is represented as a 14-bit bitfield using two six-bit characters.
                buffer.push(
                    SongTagCode.effects, 
                    base64IntToCharCode[(instrument.effects >> 12) & 63], 
                    base64IntToCharCode[(instrument.effects >> 6) & 63], 
                    base64IntToCharCode[instrument.effects & 63]
                );
                if (effectsIncludeNoteFilter(instrument.effects)) {
                    buffer.push(base64IntToCharCode[+instrument.noteFilterType]);
                    if (instrument.noteFilterType) {
                        buffer.push(base64IntToCharCode[instrument.noteFilterSimpleCut]);
                        buffer.push(base64IntToCharCode[instrument.noteFilterSimplePeak]);
                    } else {
                        if (instrument.noteFilter == null) {
                            // Push null filter settings
                            buffer.push(base64IntToCharCode[0]);
                            console.log("Null note filter settings detected in toBase64String for channelIndex " + channelIndex + ", instrumentIndex " + i);
                        } else {
                            buffer.push(base64IntToCharCode[instrument.noteFilter.controlPointCount]);
                            for (let j: number = 0; j < instrument.noteFilter.controlPointCount; j++) {
                                const point: FilterControlPoint = instrument.noteFilter.controlPoints[j];
                                buffer.push(base64IntToCharCode[point.type], base64IntToCharCode[Math.round(point.freq)], base64IntToCharCode[Math.round(point.gain)]);
                            }
                        }

                        // Push subfilters as well. Skip Index 0, is a copy of the base filter.
                        let usingSubFilterBitfield: number = 0;
                        for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
                            usingSubFilterBitfield |= (+(instrument.noteSubFilters[j + 1] != null) << j);
                        }
                        // Put subfilter usage into 2 chars (12 bits)
                        buffer.push(base64IntToCharCode[usingSubFilterBitfield >> 6], base64IntToCharCode[usingSubFilterBitfield & 63]);
                        // Put subfilter info in for all used subfilters
                        for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
                            if (usingSubFilterBitfield & (1 << j)) {
                                buffer.push(base64IntToCharCode[instrument.noteSubFilters[j + 1]!.controlPointCount]);
                                for (let k: number = 0; k < instrument.noteSubFilters[j + 1]!.controlPointCount; k++) {
                                    const point: FilterControlPoint = instrument.noteSubFilters[j + 1]!.controlPoints[k];
                                    buffer.push(base64IntToCharCode[point.type], base64IntToCharCode[Math.round(point.freq)], base64IntToCharCode[Math.round(point.gain)]);
                                }
                            }
                        }
                    }
                }
                if (effectsIncludeTransition(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.transition]);
                }
                if (effectsIncludeChord(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.chord]);
                    // Custom arpeggio speed... only if the instrument arpeggiates.
                    if (instrument.chord == Config.chords.dictionary["arpeggio"].index) {
                        buffer.push(base64IntToCharCode[instrument.arpeggioSpeed]);
                        buffer.push(base64IntToCharCode[+instrument.fastTwoNoteArp]); // Two note arp setting piggybacks on this
                    }
                    if (instrument.chord == Config.chords.dictionary["monophonic"].index) {
                        buffer.push(base64IntToCharCode[instrument.monoChordTone]); //which note is selected
                    }
                }
                if (effectsIncludePitchShift(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.pitchShift]);
                }
                if (effectsIncludeDetune(instrument.effects)) {
                    buffer.push(base64IntToCharCode[(instrument.detune - Config.detuneMin) >> 6], base64IntToCharCode[(instrument.detune - Config.detuneMin) & 0x3F]);
                }
                if (effectsIncludeVibrato(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.vibrato]);
                    // Custom vibrato settings
                    if (instrument.vibrato == Config.vibratos.length) {
                        buffer.push(base64IntToCharCode[Math.round(instrument.vibratoDepth * 25)]);
                        buffer.push(base64IntToCharCode[instrument.vibratoSpeed]);
                        buffer.push(base64IntToCharCode[Math.round(instrument.vibratoDelay)]);
                        buffer.push(base64IntToCharCode[instrument.vibratoType]);
                    }
                }
                if (effectsIncludeDistortion(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.distortion]);
                    // Aliasing is tied into distortion for now
                    buffer.push(base64IntToCharCode[+instrument.aliases]);
                }
                if (effectsIncludeBitcrusher(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.bitcrusherFreq], base64IntToCharCode[instrument.bitcrusherQuantization]);
                }
                if (effectsIncludePanning(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.pan >> 6], base64IntToCharCode[instrument.pan & 0x3f]);
                    buffer.push(base64IntToCharCode[instrument.panDelay]);
                }
                if (effectsIncludeChorus(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.chorus]);
                }
                if (effectsIncludeEcho(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.echoSustain], base64IntToCharCode[instrument.echoDelay]);
                }
                if (effectsIncludeReverb(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.reverb]);
                }
                if (effectsIncludeGranular(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.granular]);
                    buffer.push(base64IntToCharCode[instrument.grainSize]);
                    buffer.push(base64IntToCharCode[instrument.grainAmounts]);
                    buffer.push(base64IntToCharCode[instrument.grainRange]);
                }
                if (effectsIncludeRingModulation(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.ringModulation]);
                    buffer.push(base64IntToCharCode[instrument.ringModulationHz]);
                    buffer.push(base64IntToCharCode[instrument.ringModWaveformIndex]);
                    buffer.push(base64IntToCharCode[(instrument.ringModPulseWidth)]);
                    buffer.push(base64IntToCharCode[(instrument.ringModHzOffset - Config.rmHzOffsetMin) >> 6], base64IntToCharCode[(instrument.ringModHzOffset - Config.rmHzOffsetMin) & 0x3F]);
                }
                
                if (effectsIncludePhaser(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.phaserFreq]);
                    buffer.push(base64IntToCharCode[instrument.phaserFeedback]);
                    buffer.push(base64IntToCharCode[instrument.phaserStages]);
                    buffer.push(base64IntToCharCode[instrument.phaserMix]);
                }

                if (effectsIncludeInvertWave(instrument.effects)) {
                    buffer.push(base64IntToCharCode[+instrument.invertWave]);
                }
                if (effectsIncludeNoteRange(instrument.effects)) {
                    buffer.push(base64IntToCharCode[instrument.upperNoteLimit >> 6], base64IntToCharCode[instrument.upperNoteLimit & 0x3f]);
                    buffer.push(base64IntToCharCode[instrument.lowerNoteLimit >> 6], base64IntToCharCode[instrument.lowerNoteLimit & 0x3f]);
                }

                // BreakBox: sample pitch lock flag. Placed after the effects payload so
                // older parsers (no case for this tag) skip it as a harmless unknown command.
                if (instrument.samplePitchLock) {
                    buffer.push(SongTagCode.samplePitchLock, base64IntToCharCode[1]);
                }

                if (instrument.type != InstrumentType.drumset) {
                    buffer.push(SongTagCode.fadeInOut, base64IntToCharCode[instrument.fadeIn], base64IntToCharCode[instrument.fadeOut]);
                    // Transition info follows transition song tag
                    buffer.push(base64IntToCharCode[+instrument.clicklessTransition]);
                }

                if (instrument.type == InstrumentType.harmonics || instrument.type == InstrumentType.pickedString) {
                    buffer.push(SongTagCode.harmonics);
                    const harmonicsBits: BitFieldWriter = new BitFieldWriter();
                    for (let i: number = 0; i < Config.harmonicsControlPoints; i++) {
                        harmonicsBits.write(Config.harmonicsControlPointBits, instrument.harmonicsWave.harmonics[i]);
                    }
                    harmonicsBits.encodeBase64(buffer);
                }

                if (instrument.type == InstrumentType.chip) {
                    if (instrument.chipWave > 186) {
                        buffer.push(119, base64IntToCharCode[instrument.chipWave - 186]);
                        buffer.push(base64IntToCharCode[3]);
                    }
                    else if (instrument.chipWave > 124) {
                        buffer.push(119, base64IntToCharCode[instrument.chipWave - 124]);
                        buffer.push(base64IntToCharCode[2]);
                    }
                    else if (instrument.chipWave > 62) {
                        buffer.push(119, base64IntToCharCode[instrument.chipWave - 62]);
                        buffer.push(base64IntToCharCode[1]);
                    }
                    else {
                        buffer.push(119, base64IntToCharCode[instrument.chipWave]);
                        buffer.push(base64IntToCharCode[0]);
                    }
                    buffer.push(104, base64IntToCharCode[instrument.unison]);
                    if (instrument.unison == Config.unisons.length) encodeUnisonSettings(buffer, instrument.unisonVoices, instrument.unisonSpread, instrument.unisonOffset, instrument.unisonExpression, instrument.unisonSign);

                    // Repurposed for chip wave loop controls.
                    buffer.push(SongTagCode.loopControls);
                    // The encoding here is as follows:
                    // 0b11111_1
                    //         ^-- isUsingAdvancedLoopControls
                    //   ^^^^^---- chipWaveLoopMode
                    // This essentially allocates 32 different loop modes,
                    // which should be plenty.
                    const encodedLoopMode: number = (
                        (clamp(0, 31 + 1, instrument.chipWaveLoopMode) << 1)
                        | (instrument.isUsingAdvancedLoopControls ? 1 : 0)
                    );
                    buffer.push(base64IntToCharCode[encodedLoopMode]);
                    // The same encoding above is used here, but with the release mode
                    // (which isn't implemented currently), and the backwards toggle.
                    const encodedReleaseMode: number = (
                        (clamp(0, 31 + 1, 0) << 1)
                        | (instrument.chipWavePlayBackwards ? 1 : 0)
                    );
                    buffer.push(base64IntToCharCode[encodedReleaseMode]);
                    encode32BitNumber(buffer, instrument.chipWaveLoopStart);
                    encode32BitNumber(buffer, instrument.chipWaveLoopEnd);
                    encode32BitNumber(buffer, instrument.chipWaveStartOffset);

                } else if (instrument.type == InstrumentType.fm || instrument.type == InstrumentType.fm6op) {
                    if (instrument.type == InstrumentType.fm) {
                        buffer.push(SongTagCode.algorithm, base64IntToCharCode[instrument.algorithm]);
                        buffer.push(SongTagCode.feedbackType, base64IntToCharCode[instrument.feedbackType]);
                    } else {
                        buffer.push(SongTagCode.algorithm, base64IntToCharCode[instrument.algorithm6Op]);
                        if (instrument.algorithm6Op == 0) {
                            buffer.push(SongTagCode.chord, base64IntToCharCode[instrument.customAlgorithm.carrierCount]);
                            buffer.push(SongTagCode.effects);
                            for (let o: number = 0; o < instrument.customAlgorithm.modulatedBy.length; o++) {
                                for (let j: number = 0; j < instrument.customAlgorithm.modulatedBy[o].length; j++) {
                                    buffer.push(base64IntToCharCode[instrument.customAlgorithm.modulatedBy[o][j]]);
                                }
                                buffer.push(SongTagCode.operatorWaves);
                            }
                            buffer.push(SongTagCode.effects);
                        }
                        buffer.push(SongTagCode.feedbackType, base64IntToCharCode[instrument.feedbackType6Op]);
                        if (instrument.feedbackType6Op == 0) {
                            buffer.push(SongTagCode.effects);
                            for (let o: number = 0; o < instrument.customFeedbackType.indices.length; o++) {
                                for (let j: number = 0; j < instrument.customFeedbackType.indices[o].length; j++) {
                                    buffer.push(base64IntToCharCode[instrument.customFeedbackType.indices[o][j]]);
                                }
                                buffer.push(SongTagCode.operatorWaves);
                            }
                            buffer.push(SongTagCode.effects);
                        }
                    }
                    buffer.push(SongTagCode.feedbackAmplitude, base64IntToCharCode[instrument.feedbackAmplitude]);

                    buffer.push(SongTagCode.operatorFrequencies);
                    for (let o: number = 0; o < (instrument.type == InstrumentType.fm6op ? 6 : Config.operatorCount); o++) {
                        buffer.push(base64IntToCharCode[instrument.operators[o].frequency]);
                    }
                    buffer.push(SongTagCode.operatorAmplitudes);
                    for (let o: number = 0; o < (instrument.type == InstrumentType.fm6op ? 6 : Config.operatorCount); o++) {
                        buffer.push(base64IntToCharCode[instrument.operators[o].amplitude]);
                    }
                    buffer.push(SongTagCode.operatorWaves);
                    for (let o: number = 0; o < (instrument.type == InstrumentType.fm6op ? 6 : Config.operatorCount); o++) {
                        buffer.push(base64IntToCharCode[instrument.operators[o].waveform]);
                        // Push pulse width if that type is used
                        if (instrument.operators[o].waveform == 2) {
                            buffer.push(base64IntToCharCode[instrument.operators[o].pulseWidth]);
                        }
                    }
                } else if (instrument.type == InstrumentType.customChipWave) {
                    if (instrument.chipWave > 186) {
                        buffer.push(119, base64IntToCharCode[instrument.chipWave - 186]);
                        buffer.push(base64IntToCharCode[3]);
                    }
                    else if (instrument.chipWave > 124) {
                        buffer.push(119, base64IntToCharCode[instrument.chipWave - 124]);
                        buffer.push(base64IntToCharCode[2]);
                    }
                    else if (instrument.chipWave > 62) {
                        buffer.push(119, base64IntToCharCode[instrument.chipWave - 62]);
                        buffer.push(base64IntToCharCode[1]);
                    }
                    else {
                        buffer.push(119, base64IntToCharCode[instrument.chipWave]);
                        buffer.push(base64IntToCharCode[0]);
                    }
                    buffer.push(104, base64IntToCharCode[instrument.unison]);
                    if (instrument.unison == Config.unisons.length) encodeUnisonSettings(buffer, instrument.unisonVoices, instrument.unisonSpread, instrument.unisonOffset, instrument.unisonExpression, instrument.unisonSign);
                    buffer.push(SongTagCode.customChipWave);
                    // Push custom wave values
                    for (let j: number = 0; j < 64; j++) {
                        buffer.push(base64IntToCharCode[(instrument.customChipWave[j] + 24) as number]);
                    }
                } else if (instrument.type == InstrumentType.noise) {
                    buffer.push(SongTagCode.wave, base64IntToCharCode[instrument.chipNoise]);
                    buffer.push(SongTagCode.unison, base64IntToCharCode[instrument.unison]);
                    if (instrument.unison == Config.unisons.length) encodeUnisonSettings(buffer, instrument.unisonVoices, instrument.unisonSpread, instrument.unisonOffset, instrument.unisonExpression, instrument.unisonSign);
                } else if (instrument.type == InstrumentType.spectrum) {
                    buffer.push(SongTagCode.spectrum);
                    const spectrumBits: BitFieldWriter = new BitFieldWriter();
                    for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
                        spectrumBits.write(Config.spectrumControlPointBits, instrument.spectrumWave.spectrum[i]);
                    }
                    spectrumBits.encodeBase64(buffer);
                    buffer.push(SongTagCode.unison, base64IntToCharCode[instrument.unison]);
                    if (instrument.unison == Config.unisons.length) encodeUnisonSettings(buffer, instrument.unisonVoices, instrument.unisonSpread, instrument.unisonOffset, instrument.unisonExpression, instrument.unisonSign);
                } else if (instrument.type == InstrumentType.drumset) {
                    buffer.push(SongTagCode.drumsetEnvelopes);
                    for (let j: number = 0; j < Config.drumCount; j++) {
                        buffer.push(base64IntToCharCode[instrument.drumsetEnvelopes[j]]);
                    }

                    buffer.push(SongTagCode.spectrum);
                    const spectrumBits: BitFieldWriter = new BitFieldWriter();
                    for (let j: number = 0; j < Config.drumCount; j++) {
                        for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
                            spectrumBits.write(Config.spectrumControlPointBits, instrument.drumsetSpectrumWaves[j].spectrum[i]);
                        }
                    }
                    spectrumBits.encodeBase64(buffer);
                    buffer.push(SongTagCode.unison, base64IntToCharCode[instrument.unison]);
                    if (instrument.unison == Config.unisons.length) encodeUnisonSettings(buffer, instrument.unisonVoices, instrument.unisonSpread, instrument.unisonOffset, instrument.unisonExpression, instrument.unisonSign);
                } else if (instrument.type == InstrumentType.harmonics) {
                    buffer.push(SongTagCode.unison, base64IntToCharCode[instrument.unison]);
                    if (instrument.unison == Config.unisons.length) encodeUnisonSettings(buffer, instrument.unisonVoices, instrument.unisonSpread, instrument.unisonOffset, instrument.unisonExpression, instrument.unisonSign);
                } else if (instrument.type == InstrumentType.pwm) {
                    buffer.push(SongTagCode.pulseWidth, base64IntToCharCode[instrument.pulseWidth]);
                    buffer.push(base64IntToCharCode[instrument.decimalOffset >> 6], base64IntToCharCode[instrument.decimalOffset & 0x3f]);
                    buffer.push(SongTagCode.unison, base64IntToCharCode[instrument.unison]);
                    if (instrument.unison == Config.unisons.length) encodeUnisonSettings(buffer, instrument.unisonVoices, instrument.unisonSpread, instrument.unisonOffset, instrument.unisonExpression, instrument.unisonSign);
                } else if (instrument.type == InstrumentType.supersaw) {
                    buffer.push(SongTagCode.supersaw, base64IntToCharCode[instrument.supersawDynamism], base64IntToCharCode[instrument.supersawSpread], base64IntToCharCode[instrument.supersawShape]);
                    buffer.push(SongTagCode.pulseWidth, base64IntToCharCode[instrument.pulseWidth]);
                    buffer.push(base64IntToCharCode[instrument.decimalOffset >> 6], base64IntToCharCode[instrument.decimalOffset & 0x3f]);
                    buffer.push(104, base64IntToCharCode[instrument.unison]);
                    if (instrument.unison == Config.unisons.length) encodeUnisonSettings(buffer, instrument.unisonVoices, instrument.unisonSpread, instrument.unisonOffset, instrument.unisonExpression, instrument.unisonSign);
                } else if (instrument.type == InstrumentType.pickedString) {
                    if (Config.stringSustainRange > 0x20 || SustainType.length > 2) {
                        throw new Error("Not enough bits to represent sustain value and type in same base64 character.");
                    }
                    buffer.push(SongTagCode.unison, base64IntToCharCode[instrument.unison]);
                    if (instrument.unison == Config.unisons.length) encodeUnisonSettings(buffer, instrument.unisonVoices, instrument.unisonSpread, instrument.unisonOffset, instrument.unisonExpression, instrument.unisonSign);
                    buffer.push(SongTagCode.stringSustain, base64IntToCharCode[instrument.stringSustain | (instrument.stringSustainType << 5)]);
                } else if (instrument.type == InstrumentType.mod) {
                    // Handled down below. Could be moved, but meh.
                } else {
                    throw new Error("Unknown instrument type.");
                }

                buffer.push(SongTagCode.envelopes, base64IntToCharCode[instrument.envelopeCount]);
                // Added in JB v6: Options for envelopes come next.
                buffer.push(base64IntToCharCode[instrument.envelopeSpeed]);
                for (let envelopeIndex: number = 0; envelopeIndex < instrument.envelopeCount; envelopeIndex++) {
                    buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].target]);
                    if (Config.instrumentAutomationTargets[instrument.envelopes[envelopeIndex].target].maxCount > 1) {
                        buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].index]);
                    }
                    buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].envelope]);
                    //run pitch envelope handling
                    if (Config.newEnvelopes[instrument.envelopes[envelopeIndex].envelope].name == "pitch") {
                        if (!instrument.isNoiseInstrument) {
                            buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].pitchEnvelopeStart >> 6], base64IntToCharCode[instrument.envelopes[envelopeIndex].pitchEnvelopeStart & 0x3f]);
                            buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].pitchEnvelopeEnd >> 6], base64IntToCharCode[instrument.envelopes[envelopeIndex].pitchEnvelopeEnd & 0x3f]);
                        } else {
                            buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].pitchEnvelopeStart]);
                            buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].pitchEnvelopeEnd]);
                        }
                        //random
                    } else if (Config.newEnvelopes[instrument.envelopes[envelopeIndex].envelope].name == "random") {
                        buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].steps]);
                        buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].seed]);
                        buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].waveform]);
                        //lfo
                    } else if (Config.newEnvelopes[instrument.envelopes[envelopeIndex].envelope].name == "lfo") {
                        buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].waveform]);
                        if (instrument.envelopes[envelopeIndex].waveform == LFOEnvelopeTypes.steppedSaw || instrument.envelopes[envelopeIndex].waveform == LFOEnvelopeTypes.steppedTri) {
                            buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].steps]);
                        }
                    }
                    //inverse
                    let checkboxValues: number = +instrument.envelopes[envelopeIndex].discrete;
                    checkboxValues = checkboxValues << 1;
                    checkboxValues += +instrument.envelopes[envelopeIndex].inverse;
                    buffer.push(base64IntToCharCode[checkboxValues] ? base64IntToCharCode[checkboxValues] : base64IntToCharCode[0]);
                    //midbox envelope port
                    if (Config.newEnvelopes[instrument.envelopes[envelopeIndex].envelope].name != "pitch" && Config.newEnvelopes[instrument.envelopes[envelopeIndex].envelope].name != "note size" && Config.newEnvelopes[instrument.envelopes[envelopeIndex].envelope].name != "punch" && Config.newEnvelopes[instrument.envelopes[envelopeIndex].envelope].name != "none") {
                        buffer.push(base64IntToCharCode[Config.perEnvelopeSpeedToIndices[instrument.envelopes[envelopeIndex].perEnvelopeSpeed]]);
                    }
                    buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].perEnvelopeLowerBound * 10]);
                    buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].perEnvelopeUpperBound * 10]);
                }
            }
        }

        buffer.push(SongTagCode.bars);
        bits = new BitFieldWriter();
        let neededBits: number = 0;
        while ((1 << neededBits) < this.patternsPerChannel + 1) neededBits++;
        for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) for (let i: number = 0; i < this.barCount; i++) {
            bits.write(neededBits, this.channels[channelIndex].bars[i]);
        }
        bits.encodeBase64(buffer);

        buffer.push(SongTagCode.patterns);
        bits = new BitFieldWriter();
        const shapeBits: BitFieldWriter = new BitFieldWriter();
        const bitsPerNoteSize: number = Song.getNeededBits(Config.noteSizeMax);
        for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
            const channel: Channel = this.channels[channelIndex];
            const maxInstrumentsPerPattern: number = this.getMaxInstrumentsPerPattern(channelIndex);
            const isNoiseChannel: boolean = this.getChannelIsNoise(channelIndex);
            const isModChannel: boolean = this.getChannelIsMod(channelIndex);
            const neededInstrumentCountBits: number = Song.getNeededBits(maxInstrumentsPerPattern - Config.instrumentCountMin);
            const neededInstrumentIndexBits: number = Song.getNeededBits(channel.instruments.length - 1);

            // Some info about modulator settings immediately follows in mod channels.
            if (isModChannel) {
                const neededModInstrumentIndexBits: number = Song.getNeededBits(this.getMaxInstrumentsPerChannel() + 2);
                for (let instrumentIndex: number = 0; instrumentIndex < channel.instruments.length; instrumentIndex++) {

                    let instrument: Instrument = this.channels[channelIndex].instruments[instrumentIndex];

                    for (let mod: number = 0; mod < Config.modCount; mod++) {
                        const modChannel: number = instrument.modChannels[mod];
                        const modInstrument: number = instrument.modInstruments[mod];
                        const modSetting: number = instrument.modulators[mod];
                        const modFilter: number = instrument.modFilterTypes[mod];
                        const modEnvelope: number = instrument.modEnvelopeNumbers[mod];

                        // Still using legacy "mod status" format, but doing it manually as it's only used in the URL now.
                        // 0 - For pitch/noise
                        // 1 - (used to be For noise, not needed)
                        // 2 - For song
                        // 3 - None

                        let status: number = Config.modulators[modSetting].forSong ? 2 : 0;
                        if (modSetting == Config.modulators.dictionary["none"].index)
                            status = 3;

                        bits.write(2, status);

                        // Channel/Instrument is only used if the status isn't "song" or "none".
                        if (status == 0 || status == 1) {
                            bits.write(8, modChannel);
                            bits.write(neededModInstrumentIndexBits, modInstrument);
                        }

                        // Only used if setting isn't "none".
                        if (status != 3) {
                            bits.write(6, modSetting);
                        }

                        // Write mod filter info, only if this is a filter mod
                        if (Config.modulators[instrument.modulators[mod]].name == "eq filter" || Config.modulators[instrument.modulators[mod]].name == "note filter" || Config.modulators[instrument.modulators[mod]].name == "song eq") {
                            bits.write(6, modFilter);
                        }

                        //write envelope info only if needed
                        if (Config.modulators[instrument.modulators[mod]].name == "individual envelope speed" ||
                            Config.modulators[instrument.modulators[mod]].name == "reset envelope" ||
                            Config.modulators[instrument.modulators[mod]].name == "individual envelope lower bound" ||
                            Config.modulators[instrument.modulators[mod]].name == "individual envelope upper bound"
                        ) {
                            bits.write(6, modEnvelope);
                        }
                    }
                }
            }
            const octaveOffset: number = (isNoiseChannel || isModChannel) ? 0 : channel.octave * Config.pitchesPerOctave;
            let lastPitch: number = (isNoiseChannel ? 4 : octaveOffset);
            const recentPitches: number[] = isModChannel ? [0, 1, 2, 3, 4, 5] : (isNoiseChannel ? [4, 6, 7, 2, 3, 8, 0, 10] : [0, 7, 12, 19, 24, -5, -12]);
            const recentShapes: string[] = [];
            for (let i: number = 0; i < recentPitches.length; i++) {
                recentPitches[i] += octaveOffset;
            }
            for (const pattern of channel.patterns) {
                if (this.patternInstruments) {
                    const instrumentCount: number = validateRange(Config.instrumentCountMin, maxInstrumentsPerPattern, pattern.instruments.length);
                    bits.write(neededInstrumentCountBits, instrumentCount - Config.instrumentCountMin);
                    for (let i: number = 0; i < instrumentCount; i++) {
                        bits.write(neededInstrumentIndexBits, pattern.instruments[i]);
                    }
                }

                if (pattern.notes.length > 0) {
                    bits.write(1, 1);

                    let curPart: number = 0;
                    for (const note of pattern.notes) {

                        // For mod channels, a negative offset may be necessary.
                        if (note.start < curPart && isModChannel) {
                            bits.write(2, 0); // rest, then...
                            bits.write(1, 1); // negative offset
                            bits.writePartDuration(curPart - note.start);
                        }

                        if (note.start > curPart) {
                            bits.write(2, 0); // rest
                            if (isModChannel) bits.write(1, 0); // positive offset, only needed for mod channels
                            bits.writePartDuration(note.start - curPart);
                        }

                        shapeBits.clear();

                        // Old format was:
                        // 0: 1 pitch, 10: 2 pitches, 110: 3 pitches, 111: 4 pitches
                        // New format is:
                        //      0: 1 pitch
                        // 1[XXX]: 3 bits of binary signifying 2+ pitches
                        if (note.pitches.length == 1) {
                            shapeBits.write(1, 0);
                        } else {
                            shapeBits.write(1, 1);
                            shapeBits.write(3, note.pitches.length - 2);
                        }

                        shapeBits.writePinCount(note.pins.length - 1);

                        if (!isModChannel) {
                            shapeBits.write(bitsPerNoteSize, note.pins[0].size); // volume
                        }
                        else {
                            shapeBits.write(11, note.pins[0].size); // Modulator value. had to change from 9 to 11 for 2000 max tempo
                        }

                        let shapePart: number = 0;
                        let startPitch: number = note.pitches[0];
                        let currentPitch: number = startPitch;
                        const pitchBends: number[] = [];
                        for (let i: number = 1; i < note.pins.length; i++) {
                            const pin: NotePin = note.pins[i];
                            const nextPitch: number = startPitch + pin.interval;
                            if (currentPitch != nextPitch) {
                                shapeBits.write(1, 1);
                                pitchBends.push(nextPitch);
                                currentPitch = nextPitch;
                            } else {
                                shapeBits.write(1, 0);
                            }
                            shapeBits.writePartDuration(pin.time - shapePart);
                            shapePart = pin.time;
                            if (!isModChannel) {
                                shapeBits.write(bitsPerNoteSize, pin.size);
                            } else {
                                shapeBits.write(11, pin.size); // Modulator value. had to change from 9 to 11 for 2000 max tempo
                            }
                        }

                        const shapeString: string = String.fromCharCode.apply(null, shapeBits.encodeBase64([]));
                        const shapeIndex: number = recentShapes.indexOf(shapeString);
                        if (shapeIndex == -1) {
                            bits.write(2, 1); // new shape
                            bits.concat(shapeBits);
                        } else {
                            bits.write(1, 1); // old shape
                            bits.writeLongTail(0, 0, shapeIndex);
                            recentShapes.splice(shapeIndex, 1);
                        }
                        recentShapes.unshift(shapeString);
                        if (recentShapes.length > 10) recentShapes.pop();

                        const allPitches: number[] = note.pitches.concat(pitchBends);
                        for (let i: number = 0; i < allPitches.length; i++) {
                            const pitch: number = allPitches[i];
                            const pitchIndex: number = recentPitches.indexOf(pitch);
                            if (pitchIndex == -1) {
                                let interval: number = 0;
                                let pitchIter: number = lastPitch;
                                if (pitchIter < pitch) {
                                    while (pitchIter != pitch) {
                                        pitchIter++;
                                        if (recentPitches.indexOf(pitchIter) == -1) interval++;
                                    }
                                } else {
                                    while (pitchIter != pitch) {
                                        pitchIter--;
                                        if (recentPitches.indexOf(pitchIter) == -1) interval--;
                                    }
                                }
                                bits.write(1, 0);
                                bits.writePitchInterval(interval);
                            } else {
                                bits.write(1, 1);
                                bits.write(4, pitchIndex);
                                recentPitches.splice(pitchIndex, 1);
                            }
                            recentPitches.unshift(pitch);
                            if (recentPitches.length > 16) recentPitches.pop();

                            if (i == note.pitches.length - 1) {
                                lastPitch = note.pitches[0];
                            } else {
                                lastPitch = pitch;
                            }
                        }

                        if (note.start == 0) {
                            bits.write(1, note.continuesLastPattern ? 1 : 0);
                        }

                        curPart = note.end;
                    }

                    if (curPart < this.beatsPerBar * Config.partsPerBeat + (+isModChannel)) {
                        bits.write(2, 0); // rest
                        if (isModChannel) bits.write(1, 0); // positive offset
                        bits.writePartDuration(this.beatsPerBar * Config.partsPerBeat + (+isModChannel) - curPart);
                    }
                } else {
                    bits.write(1, 0);
                }
            }
        }
        let stringLength: number = bits.lengthBase64();
        let digits: number[] = [];
        while (stringLength > 0) {
            digits.unshift(base64IntToCharCode[stringLength & 0x3f]);
            stringLength = stringLength >> 6;
        }
        buffer.push(base64IntToCharCode[digits.length]);
        Array.prototype.push.apply(buffer, digits); // append digits to buffer.
        bits.encodeBase64(buffer);

        const maxApplyArgs: number = 64000;
        let customSamplesStr = "";
        if (EditorConfig.customSamples != undefined && EditorConfig.customSamples.length > 0) {
            customSamplesStr = "|" + EditorConfig.customSamples.join("|")

        }
        //samplemark
        if (buffer.length < maxApplyArgs) {
            // Note: Function.apply may break for long argument lists. 
            return String.fromCharCode.apply(null, buffer) + customSamplesStr;
            //samplemark
        } else {
            let result: string = "";
            for (let i: number = 0; i < buffer.length; i += maxApplyArgs) {
                result += String.fromCharCode.apply(null, buffer.slice(i, i + maxApplyArgs));
            }
            return result + customSamplesStr;
            //samplemark
        }
    }

    private static _envelopeFromLegacyIndex(legacyIndex: number): Envelope {
        // I swapped the order of "custom"/"steady", now "none"/"note size".
        if (legacyIndex == 0) legacyIndex = 1; else if (legacyIndex == 1) legacyIndex = 0;
        return Config.envelopes[clamp(0, Config.envelopes.length, legacyIndex)];
    }

    public fromBase64String(compressed: string, jsonFormat: string = "auto"): void {
        if (compressed == null || compressed == "") {
            Song._clearSamples();

            this.initToDefault(true);
            return;
        }
        let charIndex: number = 0;
        // skip whitespace.
        while (compressed.charCodeAt(charIndex) <= CharCode.SPACE) charIndex++;
        // skip hash mark.
        if (compressed.charCodeAt(charIndex) == CharCode.HASH) charIndex++;
        // if it starts with curly brace, treat it as JSON.
        if (compressed.charCodeAt(charIndex) == CharCode.LEFT_CURLY_BRACE) {
            this.fromJsonObject(JSON.parse(charIndex == 0 ? compressed : compressed.substring(charIndex)), jsonFormat);
            return;
        }
        const variantTest: number = compressed.charCodeAt(charIndex);
        //I cleaned up these boolean setters with an initial value. Idk why this wasn't done earlier...
        let fromBeepBox: boolean = false;
        let fromJummBox: boolean = false;
        let fromGoldBox: boolean = false;
        let fromUltraBox: boolean = false;
        let fromSlarmoosBox: boolean = false;
        let fromJukeBox: boolean = false;
        // let fromMidbox: boolean;
        // let fromDogebox2: boolean;
        // let fromAbyssBox: boolean;

        // Detect variant here. If version doesn't match known variant, assume it is a vanilla string which does not report variant.
        if (variantTest == 0x6A) { //"j"
            fromJummBox = true;
            charIndex++;
        } else if (variantTest == 0x67) { //"g"
            fromGoldBox = true;
            charIndex++;
        } else if (variantTest == 0x75) { //"u"
            fromUltraBox = true;
            charIndex++;
        } else if (variantTest == 0x64) { //"d" 
            fromJummBox = true;
            // to-do: add explicit dogebox2 support
            //fromDogeBox2 = true;
            charIndex++;
        } else if (variantTest == 0x61) { //"a" Abyssbox does urls the same as ultrabox //not quite anymore, but oh well
            fromUltraBox = true;
            charIndex++;
        } else if (variantTest == 0x73) { //"s"
            fromSlarmoosBox = true
            charIndex++;
        } else if (variantTest == 0x4a) { //"J"
            fromJukeBox = true
            charIndex++;
        } else {
            fromBeepBox = true;
        }
        const version: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
        if (fromBeepBox && (version == -1 || version > Song._latestBeepboxVersion || version < Song._oldestBeepboxVersion)) return;
        if (fromJummBox && (version == -1 || version > Song._latestJummBoxVersion || version < Song._oldestJummBoxVersion)) return;
        if (fromGoldBox && (version == -1 || version > Song._latestGoldBoxVersion || version < Song._oldestGoldBoxVersion)) return;
        if (fromUltraBox && (version == -1 || version > Song._latestUltraBoxVersion || version < Song._oldestUltraBoxVersion)) return;
        if (fromSlarmoosBox && (version == -1 || version > Song._latestSlarmoosBoxVersion || version < Song._oldestSlarmoosBoxVersion)) return;
        if (fromJukeBox && (version == -1 || version > Song._latestJukeBoxVersion || version < Song._oldestJukeBoxVersion)) return;
        const beforeTwo: boolean = version < 2;
        const beforeThree: boolean = version < 3;
        const beforeFour: boolean = version < 4;
        const beforeFive: boolean = version < 5;
        const beforeSix: boolean = version < 6;
        const beforeSeven: boolean = version < 7;
        const beforeEight: boolean = version < 8;
        const beforeNine: boolean = version < 9;
        this.initToDefault((fromBeepBox && beforeNine) || ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox)));
        const forceSimpleFilter: boolean = (fromBeepBox && beforeNine || fromJummBox && beforeFive);
        let willLoadLegacySamplesForOldSongs: boolean = false;

        if (fromJukeBox || fromSlarmoosBox || fromUltraBox || fromGoldBox) {
            compressed = compressed.replaceAll("%7C", "|")
            var compressed_array = compressed.split("|");
            compressed = compressed_array.shift()!;
            if (EditorConfig.customSamples == null || EditorConfig.customSamples.join(", ") != compressed_array.join(", ")) {

                Song._restoreChipWaveListToDefault();

                let willLoadLegacySamples = false;
                let willLoadNintariboxSamples = false;
                let willLoadMarioPaintboxSamples = false;
                const customSampleUrls: string[] = [];
                const customSamplePresets: Preset[] = [];
                sampleLoadingState.statusTable = {};
                sampleLoadingState.urlTable = {};
                sampleLoadingState.totalSamples = 0;
                sampleLoadingState.samplesLoaded = 0;
                sampleLoadEvents.dispatchEvent(new SampleLoadedEvent(
                    sampleLoadingState.totalSamples,
                    sampleLoadingState.samplesLoaded
                ));
                for (const url of compressed_array) {
                    if (url.toLowerCase() === "legacysamples") {
                        if (!willLoadLegacySamples) {
                            willLoadLegacySamples = true;
                            customSampleUrls.push(url);
                            loadBuiltInSamples(0);
                        }
                    }
                    else if (url.toLowerCase() === "nintariboxsamples") {
                        if (!willLoadNintariboxSamples) {
                            willLoadNintariboxSamples = true;
                            customSampleUrls.push(url);
                            loadBuiltInSamples(1);
                        }
                    }
                    else if (url.toLowerCase() === "mariopaintboxsamples") {
                        if (!willLoadMarioPaintboxSamples) {
                            willLoadMarioPaintboxSamples = true;
                            customSampleUrls.push(url);
                            loadBuiltInSamples(2);
                        }
                    }

                    else {
                        // UB version 2 URLs and below will be using the old syntax, so we do need to parse it in that case.
                        // UB version 3 URLs should only have the new syntax, though, unless the user has edited the URL manually.
                        const parseOldSyntax: boolean = beforeThree;
                        const ok: boolean = Song._parseAndConfigureCustomSample(url, customSampleUrls, customSamplePresets, sampleLoadingState, parseOldSyntax);
                        if (!ok) {
                            continue;
                        }
                    }
                }
                if (customSampleUrls.length > 0) {
                    EditorConfig.customSamples = customSampleUrls;
                }
                if (customSamplePresets.length > 0) {
                    const customSamplePresetsMap: DictionaryArray<Preset> = toNameMap(customSamplePresets);
                    EditorConfig.presetCategories[EditorConfig.presetCategories.length] = {
                        name: "Custom Sample Presets",
                        presets: customSamplePresetsMap,
                        index: EditorConfig.presetCategories.length,
                    };
                    // EditorConfig.presetCategories.splice(1, 0, {
                    // name: "Custom Sample Presets",
                    // presets: customSamplePresets,
                    // index: EditorConfig.presetCategories.length,
                    // });
                }


            }
            //samplemark
        }

        if (beforeThree && fromBeepBox) {
            // Originally, the only instrument transition was "instant" and the only drum wave was "retro".
            for (const channel of this.channels) {
                channel.instruments[0].transition = Config.transitions.dictionary["interrupt"].index;
                channel.instruments[0].effects |= 1 << EffectType.transition;
            }
            this.channels[3].instruments[0].chipNoise = 0;
        }

        let legacySettingsCache: LegacySettings[][] | null = null;
        if ((fromBeepBox && beforeNine) || ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox))) {
            // Unfortunately, old versions of BeepBox had a variety of different ways of saving
            // filter-and-envelope-related parameters in the URL, and none of them directly
            // correspond to the new way of saving these parameters. We can approximate the old
            // settings by collecting all the old settings for an instrument and passing them to
            // convertLegacySettings(), so I use this data structure to collect the settings
            // for each instrument if necessary.
            legacySettingsCache = [];
            for (let i: number = legacySettingsCache.length; i < this.getChannelCount(); i++) {
                legacySettingsCache[i] = [];
                for (let j: number = 0; j < Config.instrumentCountMin; j++) legacySettingsCache[i][j] = {};
            }
        }

        let legacyGlobalReverb: number = 0; // beforeNine reverb was song-global, record that reverb here and adapt it to instruments as needed.

        let instrumentChannelIterator: number = 0;
        let instrumentIndexIterator: number = -1;
        let command: number;
        let useSlowerArpSpeed: boolean = false;
        let useFastTwoNoteArp: boolean = false;
        while (charIndex < compressed.length) switch (command = compressed.charCodeAt(charIndex++)) {
            case SongTagCode.songTitle: {
                // Length of song name string
                var songNameLength = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                this.title = decodeURIComponent(compressed.substring(charIndex, charIndex + songNameLength));
                document.title = this.title + " - " + EditorConfig.versionDisplayName;

                charIndex += songNameLength;
            } break;
            case SongTagCode.channelCount: {
                this.pitchChannelCount = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                this.noiseChannelCount = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                if (fromBeepBox || (fromJummBox && beforeTwo)) {
                    // No mod channel support before jummbox v2
                    this.modChannelCount = 0;
                } else {
                    this.modChannelCount = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                }
                this.pitchChannelCount = validateRange(Config.pitchChannelCountMin, Config.pitchChannelCountMax, this.pitchChannelCount);
                this.noiseChannelCount = validateRange(Config.noiseChannelCountMin, Config.noiseChannelCountMax, this.noiseChannelCount);
                this.modChannelCount = validateRange(Config.modChannelCountMin, Config.modChannelCountMax, this.modChannelCount);

                for (let channelIndex = this.channels.length; channelIndex < this.getChannelCount(); channelIndex++) {
                    this.channels[channelIndex] = new Channel();
                }
                this.channels.length = this.getChannelCount();
                if ((fromBeepBox && beforeNine) || ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox))) {
                    for (let i: number = legacySettingsCache!.length; i < this.getChannelCount(); i++) {
                        legacySettingsCache![i] = [];
                        for (let j: number = 0; j < Config.instrumentCountMin; j++) legacySettingsCache![i][j] = {};
                    }
                }
            } break;
            case SongTagCode.scale: {
                this.scale = clamp(0, Config.scales.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                // All the scales were jumbled around by Jummbox. Just convert to free.
                if (this.scale == Config.scales["dictionary"]["Custom"].index) {
                    for (var i = 1; i < Config.pitchesPerOctave; i++) {
                        this.scaleCustom[i] = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] == 1; // ineffiecent? yes, all we're going to do for now? hell yes
                    }
                }
                if (fromBeepBox) this.scale = 0;
            } break;
            case SongTagCode.key: {
                if (beforeSeven && fromBeepBox) {
                    this.key = clamp(0, Config.keys.length, 11 - base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    this.octave = 0;
                } else if (fromBeepBox || fromJummBox) {
                    this.key = clamp(0, Config.keys.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    this.octave = 0;
                } else if (fromGoldBox || (beforeThree && fromUltraBox)) {
                    // GoldBox (so far) didn't introduce any new keys, but old
                    // songs made with early versions of UltraBox share the
                    // same URL format, and those can have more keys. This
                    // shouldn't really result in anything other than 0-11 for
                    // the key and 0 for the octave for GoldBox songs.
                    const rawKeyIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    const [key, octave]: [number, number] = convertLegacyKeyToKeyAndOctave(rawKeyIndex);
                    this.key = key;
                    this.octave = octave;
                } else {
                    this.key = clamp(0, Config.keys.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    this.octave = clamp(Config.octaveMin, Config.octaveMax + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + Config.octaveMin);
                }
            } break;
            case SongTagCode.loopStart: {
                if (beforeFive && fromBeepBox) {
                    this.loopStart = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                } else {
                    this.loopStart = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                }
            } break;
            case SongTagCode.loopEnd: {
                if (beforeFive && fromBeepBox) {
                    this.loopLength = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                } else {
                    this.loopLength = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 1;
                }
            } break;
            case SongTagCode.tempo: {
                if (beforeFour && fromBeepBox) {
                    this.tempo = [95, 120, 151, 190][base64CharCodeToInt[compressed.charCodeAt(charIndex++)]];
                } else if (beforeSeven && fromBeepBox) {
                    this.tempo = [88, 95, 103, 111, 120, 130, 140, 151, 163, 176, 190, 206, 222, 240, 259][base64CharCodeToInt[compressed.charCodeAt(charIndex++)]];
                } else {
                    this.tempo = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                }
                this.tempo = clamp(Config.tempoMin, Config.tempoMax + 1, this.tempo);
            } break;
            case SongTagCode.reverb: {
                if (beforeNine && fromBeepBox) {
                    legacyGlobalReverb = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 12;
                    legacyGlobalReverb = clamp(0, Config.reverbRange, legacyGlobalReverb);
                } else if ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox)) {
                    legacyGlobalReverb = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    legacyGlobalReverb = clamp(0, Config.reverbRange, legacyGlobalReverb);
                } else {
                    // Do nothing, BeepBox v9+ do not support song-wide reverb - JummBox still does via modulator.
                }
            } break;
            case SongTagCode.beatCount: {
                if (beforeThree && fromBeepBox) {
                    this.beatsPerBar = [6, 7, 8, 9, 10][base64CharCodeToInt[compressed.charCodeAt(charIndex++)]];
                } else {
                    this.beatsPerBar = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 1;
                }
                this.beatsPerBar = Math.max(Config.beatsPerBarMin, Math.min(Config.beatsPerBarMax, this.beatsPerBar));
            } break;
            case SongTagCode.barCount: {
                const barCount: number = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 1;
                this.barCount = validateRange(Config.barCountMin, Config.barCountMax, barCount);
                for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                    for (let bar = this.channels[channelIndex].bars.length; bar < this.barCount; bar++) {
                        this.channels[channelIndex].bars[bar] = (bar < 4) ? 1 : 0;
                    }
                    this.channels[channelIndex].bars.length = this.barCount;
                }
            } break;
            case SongTagCode.patternCount: {
                let patternsPerChannel: number;
                if (beforeEight && fromBeepBox) {
                    patternsPerChannel = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 1;
                } else {
                    patternsPerChannel = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 1;
                }
                this.patternsPerChannel = validateRange(1, Config.barCountMax, patternsPerChannel);
                const channelCount: number = this.getChannelCount();
                for (let channelIndex: number = 0; channelIndex < channelCount; channelIndex++) {
                    const patterns: Pattern[] = this.channels[channelIndex].patterns;
                    for (let pattern = patterns.length; pattern < this.patternsPerChannel; pattern++) {
                        patterns[pattern] = new Pattern();
                    }
                    patterns.length = this.patternsPerChannel;
                }
            } break;
            case SongTagCode.instrumentCount: {
                if ((beforeNine && fromBeepBox) || ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox))) {
                    const instrumentsPerChannel: number = validateRange(Config.instrumentCountMin, Config.patternInstrumentCountMax, base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + Config.instrumentCountMin);
                    this.layeredInstruments = false;
                    this.patternInstruments = (instrumentsPerChannel > 1);

                    for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                        const isNoiseChannel: boolean = channelIndex >= this.pitchChannelCount && channelIndex < this.pitchChannelCount + this.noiseChannelCount;
                        const isModChannel: boolean = channelIndex >= this.pitchChannelCount + this.noiseChannelCount;

                        for (let instrumentIndex: number = this.channels[channelIndex].instruments.length; instrumentIndex < instrumentsPerChannel; instrumentIndex++) {
                            this.channels[channelIndex].instruments[instrumentIndex] = new Instrument(isNoiseChannel, isModChannel);
                        }
                        this.channels[channelIndex].instruments.length = instrumentsPerChannel;
                        if (beforeSix && fromBeepBox) {
                            for (let instrumentIndex: number = 0; instrumentIndex < instrumentsPerChannel; instrumentIndex++) {
                                this.channels[channelIndex].instruments[instrumentIndex].setTypeAndReset(isNoiseChannel ? InstrumentType.noise : InstrumentType.chip, isNoiseChannel, isModChannel);
                            }
                        }

                        for (let j: number = legacySettingsCache![channelIndex].length; j < instrumentsPerChannel; j++) {
                            legacySettingsCache![channelIndex][j] = {};
                        }
                    }
                } else {
                    const instrumentsFlagBits: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    this.layeredInstruments = (instrumentsFlagBits & (1 << 1)) != 0;
                    this.patternInstruments = (instrumentsFlagBits & (1 << 0)) != 0;
                    for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                        let instrumentCount: number = 1;
                        if (this.layeredInstruments || this.patternInstruments) {
                            instrumentCount = validateRange(Config.instrumentCountMin, this.getMaxInstrumentsPerChannel(), base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + Config.instrumentCountMin);
                        }
                        const channel: Channel = this.channels[channelIndex];
                        const isNoiseChannel: boolean = this.getChannelIsNoise(channelIndex);
                        const isModChannel: boolean = this.getChannelIsMod(channelIndex);
                        for (let i: number = channel.instruments.length; i < instrumentCount; i++) {
                            channel.instruments[i] = new Instrument(isNoiseChannel, isModChannel);
                        }
                        channel.instruments.length = instrumentCount;
                    }
                }
            } break;
            case SongTagCode.rhythm: {
                if (!fromUltraBox && !fromSlarmoosBox && !fromJukeBox) {
                    let newRhythm = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    this.rhythm = clamp(0, Config.rhythms.length, newRhythm);
                    if (fromJummBox && beforeThree || fromBeepBox) {
                        if (this.rhythm == Config.rhythms.dictionary["÷3 (triplets)"].index || this.rhythm == Config.rhythms.dictionary["÷6"].index) {
                            useSlowerArpSpeed = true;
                        }
                        if (this.rhythm >= Config.rhythms.dictionary["÷6"].index) {
                            // @TODO: This assumes that 6 and 8 are in that order, but
                            // if someone reorders Config.rhythms that may not be true,
                            // so this check probably should instead look for those
                            // specific rhythms.
                            useFastTwoNoteArp = true;
                        }
                    }
                } else if ((fromSlarmoosBox && beforeFour) || (fromUltraBox && beforeFive)) {
                    const rhythmMap = [1, 1, 0, 1, 2, 3, 4, 5];
                    this.rhythm = clamp(0, Config.rhythms.length, rhythmMap[base64CharCodeToInt[compressed.charCodeAt(charIndex++)]]);
                } else {
                    this.rhythm = clamp(0, Config.rhythms.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                }
            } break;
            case SongTagCode.channelOctave: {
                if (beforeThree && fromBeepBox) {
                    const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    this.channels[channelIndex].octave = clamp(0, Config.pitchOctaves, base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 1);
                    if (channelIndex >= this.pitchChannelCount) this.channels[channelIndex].octave = 0;
                } else if ((beforeNine && fromBeepBox) || ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox))) {
                    for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                        this.channels[channelIndex].octave = clamp(0, Config.pitchOctaves, base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 1);
                        if (channelIndex >= this.pitchChannelCount) this.channels[channelIndex].octave = 0;
                    }
                } else {
                    for (let channelIndex: number = 0; channelIndex < this.pitchChannelCount; channelIndex++) {
                        this.channels[channelIndex].octave = clamp(0, Config.pitchOctaves, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    }
                    for (let channelIndex: number = this.pitchChannelCount; channelIndex < this.getChannelCount(); channelIndex++) {
                        this.channels[channelIndex].octave = 0;
                    }
                }
            } break;
            case SongTagCode.startInstrument: {
                instrumentIndexIterator++;
                if (instrumentIndexIterator >= this.channels[instrumentChannelIterator].instruments.length) {
                    instrumentChannelIterator++;
                    instrumentIndexIterator = 0;
                }
                validateRange(0, this.channels.length - 1, instrumentChannelIterator);
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                // JB before v5 had custom chip and mod before pickedString and supersaw were added. Index +2.
                let instrumentType: number = validateRange(0, InstrumentType.length - 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                if ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox)) {
                    if (instrumentType == InstrumentType.pickedString || instrumentType == InstrumentType.supersaw) {
                        instrumentType += 2;
                    }
                }
                // Similar story here, JB before v5 had custom chip and mod before supersaw was added. Index +1.
                else if ((fromJummBox && beforeSix) || (fromGoldBox && !beforeFour) || (fromUltraBox && beforeFive)) {
                    if (instrumentType == InstrumentType.supersaw || instrumentType == InstrumentType.customChipWave || instrumentType == InstrumentType.mod) {
                        instrumentType += 1;
                    }
                }
                instrument.setTypeAndReset(instrumentType, instrumentChannelIterator >= this.pitchChannelCount && instrumentChannelIterator < this.pitchChannelCount + this.noiseChannelCount, instrumentChannelIterator >= this.pitchChannelCount + this.noiseChannelCount);

                // Anti-aliasing was added in BeepBox 3.0 (v6->v7) and JummBox 1.3 (v1->v2 roughly but some leakage possible)
                if (((beforeSeven && fromBeepBox) || (beforeTwo && fromJummBox)) && (instrumentType == InstrumentType.chip || instrumentType == InstrumentType.customChipWave || instrumentType == InstrumentType.pwm)) {
                    instrument.aliases = true;
                    instrument.distortion = 0;
                    instrument.effects |= 1 << EffectType.distortion;
                }
                if (useSlowerArpSpeed) {
                    instrument.arpeggioSpeed = 9; // x3/4 speed. This used to be tied to rhythm, but now it is decoupled to each instrument's arp speed slider. This flag gets set when importing older songs to keep things consistent.
                }
                if (useFastTwoNoteArp) {
                    instrument.fastTwoNoteArp = true;
                }

                if (beforeSeven && fromBeepBox) {
                    // instrument.effects = 0;
                    // Chip/noise instruments had arpeggio and FM had custom interval but neither
                    // explicitly saved the chorus setting beforeSeven so enable it here.
                    if (instrument.chord != Config.chords.dictionary["simultaneous"].index) {
                        // Enable chord if it was used.
                        instrument.effects |= 1 << EffectType.chord;
                    }
                }
            } break;
            case SongTagCode.preset: {
                let presetValue: number = 0;
                if (fromJukeBox && !beforeFive) {
                    presetValue = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 18) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 12) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                } else if (fromJukeBox && version == 4) { 
                    presetValue = updateFromJukeBox4((base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 18) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 12) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)]));
                } else if (fromJukeBox && version == 3) { 
                    presetValue = updateFromJukeBox3((base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 18) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 12) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)]));
                } else if (fromUltraBox || fromGoldBox || fromJummBox || fromBeepBox) {
                    presetValue = updateFromUltraBox((base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)]));
                } 
                this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].preset = presetValue;
            } break;
            case SongTagCode.wave: {
                if (beforeThree && fromBeepBox) {
                    const legacyWaves: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 0];
                    const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    const instrument: Instrument = this.channels[channelIndex].instruments[0];
                    instrument.chipWave = clamp(0, Config.chipWaves.length, legacyWaves[base64CharCodeToInt[compressed.charCodeAt(charIndex++)]] | 0);

                    // Version 2 didn't save any settings for settings for filters, or envelopes,
                    // just waves, so initialize them here I guess.
                    instrument.convertLegacySettings(legacySettingsCache![channelIndex][0], forceSimpleFilter);

                } else if (beforeSix && fromBeepBox) {
                    const legacyWaves: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 0];
                    for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                        for (const instrument of this.channels[channelIndex].instruments) {
                            if (channelIndex >= this.pitchChannelCount) {
                                instrument.chipNoise = clamp(0, Config.chipNoises.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            } else {
                                instrument.chipWave = clamp(0, Config.chipWaves.length, legacyWaves[base64CharCodeToInt[compressed.charCodeAt(charIndex++)]] | 0);
                            }
                        }
                    }
                } else if (beforeSeven && fromBeepBox) {
                    const legacyWaves: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 0];
                    if (instrumentChannelIterator >= this.pitchChannelCount) {
                        this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipNoise = clamp(0, Config.chipNoises.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    } else {
                        this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipWave = clamp(0, Config.chipWaves.length, legacyWaves[base64CharCodeToInt[compressed.charCodeAt(charIndex++)]] | 0);
                    }
                } else {
                    if (this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].type == InstrumentType.noise) {
                        this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipNoise = clamp(0, Config.chipNoises.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    } else {
                        if (fromJukeBox || fromSlarmoosBox || fromUltraBox) {
                            const chipWaveReal = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                            const chipWaveCounter = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];

                            if (chipWaveCounter == 3) {
                                this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipWave = clamp(0, Config.chipWaves.length, chipWaveReal + 186);
                            } else if (chipWaveCounter == 2) {
                                this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipWave = clamp(0, Config.chipWaves.length, chipWaveReal + 124);
                            } else if (chipWaveCounter == 1) {
                                this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipWave = clamp(0, Config.chipWaves.length, chipWaveReal + 62);
                            } else {
                                this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipWave = clamp(0, Config.chipWaves.length, chipWaveReal);
                            }

                        } else {
                            this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipWave = clamp(0, Config.chipWaves.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        }
                    }
                }
            } break;
            case SongTagCode.eqFilter: {
                if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox) || (beforeFour && fromGoldBox)) {
                    if (beforeSeven && fromBeepBox) {
                        const legacyToCutoff: number[] = [10, 6, 3, 0, 8, 5, 2];
                        //const pregoldToEnvelope: number[] = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18, 19, 20, 21, 23, 24, 25, 27, 28, 29, 32, 33, 34, 31, 11];
                        const legacyToEnvelope: string[] = ["none", "none", "none", "none", "decay 1", "decay 2", "decay 3"];

                        if (beforeThree && fromBeepBox) {
                            const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                            const instrument: Instrument = this.channels[channelIndex].instruments[0];
                            const legacySettings: LegacySettings = legacySettingsCache![channelIndex][0];
                            const legacyFilter: number = [1, 3, 4, 5][clamp(0, legacyToCutoff.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)])];
                            legacySettings.filterCutoff = legacyToCutoff[legacyFilter];
                            legacySettings.filterResonance = 0;
                            legacySettings.filterEnvelope = Config.envelopes.dictionary[legacyToEnvelope[legacyFilter]];
                            instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
                        } else if (beforeSix && fromBeepBox) {
                            for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                                for (let i: number = 0; i < this.channels[channelIndex].instruments.length; i++) {
                                    const instrument: Instrument = this.channels[channelIndex].instruments[i];
                                    const legacySettings: LegacySettings = legacySettingsCache![channelIndex][i];
                                    const legacyFilter: number = clamp(0, legacyToCutoff.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 1);
                                    if (channelIndex < this.pitchChannelCount) {
                                        legacySettings.filterCutoff = legacyToCutoff[legacyFilter];
                                        legacySettings.filterResonance = 0;
                                        legacySettings.filterEnvelope = Config.envelopes.dictionary[legacyToEnvelope[legacyFilter]];
                                    } else {
                                        legacySettings.filterCutoff = 10;
                                        legacySettings.filterResonance = 0;
                                        legacySettings.filterEnvelope = Config.envelopes.dictionary["none"];
                                    }
                                    instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
                                }
                            }
                        } else {
                            const legacyFilter: number = clamp(0, legacyToCutoff.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                            const legacySettings: LegacySettings = legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
                            legacySettings.filterCutoff = legacyToCutoff[legacyFilter];
                            legacySettings.filterResonance = 0;
                            legacySettings.filterEnvelope = Config.envelopes.dictionary[legacyToEnvelope[legacyFilter]];
                            instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
                        }
                    } else {
                        const filterCutoffRange: number = 11;
                        const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                        const legacySettings: LegacySettings = legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
                        legacySettings.filterCutoff = clamp(0, filterCutoffRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
                    }
                } else {
                    const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    let typeCheck: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];

                    if (fromBeepBox || typeCheck == 0) {
                        instrument.eqFilterType = false;
                        if (fromJukeBox || fromJummBox || fromGoldBox || fromUltraBox || fromSlarmoosBox)
                            typeCheck = base64CharCodeToInt[compressed.charCodeAt(charIndex++)]; // Skip to next to get control point count
                        const originalControlPointCount: number = typeCheck;
                        instrument.eqFilter.controlPointCount = clamp(0, Config.filterMaxPoints + 1, originalControlPointCount);
                        for (let i: number = instrument.eqFilter.controlPoints.length; i < instrument.eqFilter.controlPointCount; i++) {
                            instrument.eqFilter.controlPoints[i] = new FilterControlPoint();
                        }
                        for (let i: number = 0; i < instrument.eqFilter.controlPointCount; i++) {
                            const point: FilterControlPoint = instrument.eqFilter.controlPoints[i];
                            point.type = clamp(0, FilterType.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            point.freq = clamp(0, Config.filterFreqRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            point.gain = clamp(0, Config.filterGainRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        }
                        for (let i: number = instrument.eqFilter.controlPointCount; i < originalControlPointCount; i++) {
                            charIndex += 3;
                        }

                        // Get subfilters as well. Skip Index 0, is a copy of the base filter.
                        instrument.eqSubFilters[0] = instrument.eqFilter;
                        if ((fromJummBox && !beforeFive) || (fromGoldBox && !beforeFour) || fromUltraBox || fromSlarmoosBox || fromJukeBox) {
                            let usingSubFilterBitfield: number = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
                                if (usingSubFilterBitfield & (1 << j)) {
                                    // Number of control points
                                    const originalSubfilterControlPointCount: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                                    if (instrument.eqSubFilters[j + 1] == null)
                                        instrument.eqSubFilters[j + 1] = new FilterSettings();
                                    instrument.eqSubFilters[j + 1]!.controlPointCount = clamp(0, Config.filterMaxPoints + 1, originalSubfilterControlPointCount);
                                    for (let i: number = instrument.eqSubFilters[j + 1]!.controlPoints.length; i < instrument.eqSubFilters[j + 1]!.controlPointCount; i++) {
                                        instrument.eqSubFilters[j + 1]!.controlPoints[i] = new FilterControlPoint();
                                    }
                                    for (let i: number = 0; i < instrument.eqSubFilters[j + 1]!.controlPointCount; i++) {
                                        const point: FilterControlPoint = instrument.eqSubFilters[j + 1]!.controlPoints[i];
                                        point.type = clamp(0, FilterType.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                        point.freq = clamp(0, Config.filterFreqRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                        point.gain = clamp(0, Config.filterGainRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                    }
                                    for (let i: number = instrument.eqSubFilters[j + 1]!.controlPointCount; i < originalSubfilterControlPointCount; i++) {
                                        charIndex += 3;
                                    }
                                }
                            }
                        }
                    }
                    else {
                        instrument.eqFilterType = true;
                        instrument.eqFilterSimpleCut = clamp(0, Config.filterSimpleCutRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        instrument.eqFilterSimplePeak = clamp(0, Config.filterSimplePeakRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    }
                }
            } break;
            case SongTagCode.loopControls: {
                if (fromJukeBox || fromSlarmoosBox || fromUltraBox) {
                    if (beforeThree && fromUltraBox) {
                        // Still have to support the old and bad loop control data format written as a test, sigh.
                        const sampleLoopInfoEncodedLength = decode32BitNumber(compressed, charIndex);
                        charIndex += 6;
                        const sampleLoopInfoEncoded = compressed.slice(charIndex, charIndex + sampleLoopInfoEncodedLength);
                        charIndex += sampleLoopInfoEncodedLength;
                        interface SampleLoopInfo {
                            isUsingAdvancedLoopControls: boolean;
                            chipWaveLoopStart: number;
                            chipWaveLoopEnd: number;
                            chipWaveLoopMode: number;
                            chipWavePlayBackwards: boolean;
                            chipWaveStartOffset: number;
                        }
                        interface SampleLoopInfoEntry {
                            channel: number;
                            instrument: number;
                            info: SampleLoopInfo;
                        }
                        const sampleLoopInfo: SampleLoopInfoEntry[] = JSON.parse(atob(sampleLoopInfoEncoded));
                        for (const entry of sampleLoopInfo) {
                            const channelIndex: number = entry["channel"];
                            const instrumentIndex: number = entry["instrument"];
                            const info: SampleLoopInfo = entry["info"];
                            const instrument: Instrument = this.channels[channelIndex].instruments[instrumentIndex];
                            instrument.isUsingAdvancedLoopControls = info["isUsingAdvancedLoopControls"];
                            instrument.chipWaveLoopStart = info["chipWaveLoopStart"];
                            instrument.chipWaveLoopEnd = info["chipWaveLoopEnd"];
                            instrument.chipWaveLoopMode = info["chipWaveLoopMode"];
                            instrument.chipWavePlayBackwards = info["chipWavePlayBackwards"];
                            instrument.chipWaveStartOffset = info["chipWaveStartOffset"];
                            // @TODO: Whenever chipWaveReleaseMode is implemented, it should be set here to the default.
                        }
                    } else {
                        // Read the new loop control data format.
                        // See Song.toBase64String for details on the encodings used here.
                        const encodedLoopMode: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        const isUsingAdvancedLoopControls: boolean = Boolean(encodedLoopMode & 1);
                        const chipWaveLoopMode: number = encodedLoopMode >> 1;
                        const encodedReleaseMode: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        const chipWavePlayBackwards: boolean = Boolean(encodedReleaseMode & 1);
                        // const chipWaveReleaseMode: number = encodedReleaseMode >> 1;
                        const chipWaveLoopStart: number = decode32BitNumber(compressed, charIndex);
                        charIndex += 6;
                        const chipWaveLoopEnd: number = decode32BitNumber(compressed, charIndex);
                        charIndex += 6;
                        const chipWaveStartOffset: number = decode32BitNumber(compressed, charIndex);
                        charIndex += 6;
                        const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                        instrument.isUsingAdvancedLoopControls = isUsingAdvancedLoopControls;
                        instrument.chipWaveLoopStart = chipWaveLoopStart;
                        instrument.chipWaveLoopEnd = chipWaveLoopEnd;
                        instrument.chipWaveLoopMode = chipWaveLoopMode;
                        instrument.chipWavePlayBackwards = chipWavePlayBackwards;
                        instrument.chipWaveStartOffset = chipWaveStartOffset;
                        // instrument.chipWaveReleaseMode = chipWaveReleaseMode;
                    }
                }
                else if (fromGoldBox && !beforeFour && beforeSix) {
                    if (document.URL.substring(document.URL.length - 13).toLowerCase() != "legacysamples") {
                        if (!willLoadLegacySamplesForOldSongs) {
                            willLoadLegacySamplesForOldSongs = true;
                            Config.willReloadForCustomSamples = true;
                            EditorConfig.customSamples = ["legacySamples"];
                            loadBuiltInSamples(0);
                        }
                    }
                    this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipWave = clamp(0, Config.chipWaves.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 125);
                } else if ((beforeNine && fromBeepBox) || ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox))) {
                    const filterResonanceRange: number = 8;
                    const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    const legacySettings: LegacySettings = legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
                    legacySettings.filterResonance = clamp(0, filterResonanceRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    instrument.convertLegacySettings(legacySettings, forceSimpleFilter);

                }
            } break;
            case SongTagCode.drumsetEnvelopes: {
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                const pregoldToEnvelope: number[] = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18, 19, 20, 21, 23, 24, 25, 27, 28, 29, 32, 33, 34, 31, 11];
                if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox) || (beforeFour && fromGoldBox)) {
                    if ((beforeTwo && fromGoldBox) || (!fromGoldBox && !fromUltraBox && !fromSlarmoosBox && !fromJukeBox)) {

                    }
                    if (instrument.type == InstrumentType.drumset) {
                        for (let i: number = 0; i < Config.drumCount; i++) {
                            let aa: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                            if ((beforeTwo && fromGoldBox) || (!fromGoldBox && !fromUltraBox && !fromSlarmoosBox && !fromJukeBox)) aa = pregoldToEnvelope[aa];
                            instrument.drumsetEnvelopes[i] = Song._envelopeFromLegacyIndex(aa).index;
                        }
                    } else {
                        // This used to be used for general filter envelopes.
                        // The presence of an envelope affects how convertLegacySettings
                        // decides the closest possible approximation, so update it.
                        const legacySettings: LegacySettings = legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
                        let aa: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        if ((beforeTwo && fromGoldBox) || (!fromGoldBox && !fromUltraBox && !fromSlarmoosBox && !fromJukeBox)) aa = pregoldToEnvelope[aa];
                        legacySettings.filterEnvelope = Song._envelopeFromLegacyIndex(aa);
                        instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
                    }
                } else {
                    // This tag is now only used for drumset filter envelopes.
                    for (let i: number = 0; i < Config.drumCount; i++) {
                        let aa: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        if ((beforeTwo && fromGoldBox) || (!fromGoldBox && !fromUltraBox && !fromSlarmoosBox && !fromJukeBox)) aa = pregoldToEnvelope[aa];
                        if (!fromSlarmoosBox && !fromJukeBox && aa >= 2) aa++; //2 for pitch
                        instrument.drumsetEnvelopes[i] = clamp(0, Config.envelopes.length, aa);
                    }
                }
            } break;
            case SongTagCode.pulseWidth: {
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                instrument.pulseWidth = clamp(0, Config.pulseWidthRange + (+(fromJummBox)) + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                if (fromBeepBox) {
                    // BeepBox formula
                    instrument.pulseWidth = Math.round(Math.pow(0.5, (7 - instrument.pulseWidth) * Config.pulseWidthStepPower) * Config.pulseWidthRange);

                }

                if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox) || (beforeFour && fromGoldBox)) {
                    const pregoldToEnvelope: number[] = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18, 19, 20, 21, 23, 24, 25, 27, 28, 29, 32, 33, 34, 31, 11];
                    const legacySettings: LegacySettings = legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
                    let aa: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    if ((beforeTwo && fromGoldBox) || (!fromGoldBox && !fromUltraBox && !fromSlarmoosBox && !fromJukeBox)) aa = pregoldToEnvelope[aa];
                    legacySettings.pulseEnvelope = Song._envelopeFromLegacyIndex(aa);
                    instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
                }

                if ((fromUltraBox && !beforeFour) || fromSlarmoosBox || fromJukeBox) {
                    instrument.decimalOffset = clamp(0, 99 + 1, (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                }

            } break;
            case SongTagCode.stringSustain: {
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                const sustainValue: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                instrument.stringSustain = clamp(0, Config.stringSustainRange, sustainValue & 0x1F);
                instrument.stringSustainType = Config.enableAcousticSustain ? clamp(0, SustainType.length, sustainValue >> 5) : SustainType.bright;
            } break;
            case SongTagCode.fadeInOut: {
                if ((beforeNine && fromBeepBox) || ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox))) {
                    // this tag was used for a combination of transition and fade in/out.
                    const legacySettings = [
                        { transition: "interrupt", fadeInSeconds: 0.0, fadeOutTicks: -1 },
                        { transition: "normal", fadeInSeconds: 0.0, fadeOutTicks: -3 },
                        { transition: "normal", fadeInSeconds: 0.025, fadeOutTicks: -3 },
                        { transition: "slide in pattern", fadeInSeconds: 0.025, fadeOutTicks: -3 },
                        { transition: "normal", fadeInSeconds: 0.04, fadeOutTicks: 6 },
                        { transition: "normal", fadeInSeconds: 0.0, fadeOutTicks: 48 },
                        { transition: "normal", fadeInSeconds: 0.0125, fadeOutTicks: 72 },
                        { transition: "normal", fadeInSeconds: 0.06, fadeOutTicks: 96 },
                        { transition: "slide in pattern", fadeInSeconds: 0.025, fadeOutTicks: -3 },
                    ];
                    if (beforeThree && fromBeepBox) {
                        const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        const settings = legacySettings[clamp(0, legacySettings.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)])];
                        const instrument: Instrument = this.channels[channelIndex].instruments[0];
                        instrument.fadeIn = Synth.secondsToFadeInSetting(settings.fadeInSeconds);
                        instrument.fadeOut = Synth.ticksToFadeOutSetting(settings.fadeOutTicks);
                        instrument.transition = Config.transitions.dictionary[settings.transition].index;
                        if (instrument.transition != Config.transitions.dictionary["normal"].index) {
                            // Enable transition if it was used.
                            instrument.effects |= 1 << EffectType.transition;
                        }
                    } else if (beforeSix && fromBeepBox) {
                        for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                            for (const instrument of this.channels[channelIndex].instruments) {
                                const settings = legacySettings[clamp(0, legacySettings.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)])];
                                instrument.fadeIn = Synth.secondsToFadeInSetting(settings.fadeInSeconds);
                                instrument.fadeOut = Synth.ticksToFadeOutSetting(settings.fadeOutTicks);
                                instrument.transition = Config.transitions.dictionary[settings.transition].index;
                                if (instrument.transition != Config.transitions.dictionary["normal"].index) {
                                    // Enable transition if it was used.
                                    instrument.effects |= 1 << EffectType.transition;
                                }
                            }
                        }
                    } else if ((beforeFour && !fromGoldBox && !fromUltraBox && !fromSlarmoosBox && !fromJukeBox) || fromBeepBox) {
                        const settings = legacySettings[clamp(0, legacySettings.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)])];
                        const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                        instrument.fadeIn = Synth.secondsToFadeInSetting(settings.fadeInSeconds);
                        instrument.fadeOut = Synth.ticksToFadeOutSetting(settings.fadeOutTicks);
                        instrument.transition = Config.transitions.dictionary[settings.transition].index;
                        if (instrument.transition != Config.transitions.dictionary["normal"].index) {
                            // Enable transition if it was used.
                            instrument.effects |= 1 << EffectType.transition;
                        }
                    } else {
                        const settings = legacySettings[clamp(0, legacySettings.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)])];
                        const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                        instrument.fadeIn = Synth.secondsToFadeInSetting(settings.fadeInSeconds);
                        instrument.fadeOut = Synth.ticksToFadeOutSetting(settings.fadeOutTicks);
                        instrument.transition = Config.transitions.dictionary[settings.transition].index;

                        // Read tie-note 
                        if (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] > 0) {
                            // Set legacy tie over flag, which is only used to port notes in patterns using this instrument as tying.
                            instrument.legacyTieOver = true;

                        }
                        instrument.clicklessTransition = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] ? true : false;

                        if (instrument.transition != Config.transitions.dictionary["normal"].index || instrument.clicklessTransition) {
                            // Enable transition if it was used.
                            instrument.effects |= 1 << EffectType.transition;
                        }
                    }
                } else {
                    const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    instrument.fadeIn = clamp(0, Config.fadeInRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    instrument.fadeOut = clamp(0, Config.fadeOutTicks.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    if (fromJummBox || fromGoldBox || fromUltraBox || fromSlarmoosBox || fromJukeBox)
                        instrument.clicklessTransition = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] ? true : false;
                }
            } break;
            case SongTagCode.songEq: { //deprecated vibrato tag repurposed for songEq
                if ((beforeNine && fromBeepBox) || ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox))) {
                    if (beforeSeven && fromBeepBox) {
                        if (beforeThree && fromBeepBox) {
                            const legacyEffects: number[] = [0, 3, 2, 0];
                            const legacyEnvelopes: string[] = ["none", "none", "none", "tremolo2"];
                            const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                            const effect: number = clamp(0, legacyEffects.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            const instrument: Instrument = this.channels[channelIndex].instruments[0];
                            const legacySettings: LegacySettings = legacySettingsCache![channelIndex][0];
                            instrument.vibrato = legacyEffects[effect];
                            if (legacySettings.filterEnvelope == undefined || legacySettings.filterEnvelope.type == EnvelopeType.none) {
                                // Imitate the legacy tremolo with a filter envelope.
                                legacySettings.filterEnvelope = Config.envelopes.dictionary[legacyEnvelopes[effect]];
                                instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
                            }
                            if (instrument.vibrato != Config.vibratos.dictionary["none"].index) {
                                // Enable vibrato if it was used.
                                instrument.effects |= 1 << EffectType.vibrato;
                            }
                        } else if (beforeSix && fromBeepBox) {
                            const legacyEffects: number[] = [0, 1, 2, 3, 0, 0];
                            const legacyEnvelopes: string[] = ["none", "none", "none", "none", "tremolo5", "tremolo2"];
                            for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                                for (let i: number = 0; i < this.channels[channelIndex].instruments.length; i++) {
                                    const effect: number = clamp(0, legacyEffects.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                    const instrument: Instrument = this.channels[channelIndex].instruments[i];
                                    const legacySettings: LegacySettings = legacySettingsCache![channelIndex][i];
                                    instrument.vibrato = legacyEffects[effect];
                                    if (legacySettings.filterEnvelope == undefined || legacySettings.filterEnvelope.type == EnvelopeType.none) {
                                        // Imitate the legacy tremolo with a filter envelope.
                                        legacySettings.filterEnvelope = Config.envelopes.dictionary[legacyEnvelopes[effect]];
                                        instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
                                    }
                                    if (instrument.vibrato != Config.vibratos.dictionary["none"].index) {
                                        // Enable vibrato if it was used.
                                        instrument.effects |= 1 << EffectType.vibrato;
                                    }
                                    if ((legacyGlobalReverb != 0 || ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox))) && !this.getChannelIsNoise(channelIndex)) {
                                        // Enable reverb if it was used globaly before. (Global reverb was added before the effects option so I need to pick somewhere else to initialize instrument reverb, and I picked the vibrato command.)
                                        instrument.effects |= 1 << EffectType.reverb;
                                        instrument.reverb = legacyGlobalReverb;
                                    }
                                }
                            }
                        } else {
                            const legacyEffects: number[] = [0, 1, 2, 3, 0, 0];
                            const legacyEnvelopes: string[] = ["none", "none", "none", "none", "tremolo5", "tremolo2"];
                            const effect: number = clamp(0, legacyEffects.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                            const legacySettings: LegacySettings = legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
                            instrument.vibrato = legacyEffects[effect];
                            if (legacySettings.filterEnvelope == undefined || legacySettings.filterEnvelope.type == EnvelopeType.none) {
                                // Imitate the legacy tremolo with a filter envelope.
                                legacySettings.filterEnvelope = Config.envelopes.dictionary[legacyEnvelopes[effect]];
                                instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
                            }
                            if (instrument.vibrato != Config.vibratos.dictionary["none"].index) {
                                // Enable vibrato if it was used.
                                instrument.effects |= 1 << EffectType.vibrato;
                            }
                            if (legacyGlobalReverb != 0 || ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox))) {
                                // Enable reverb if it was used globaly before. (Global reverb was added before the effects option so I need to pick somewhere else to initialize instrument reverb, and I picked the vibrato command.)
                                instrument.effects |= 1 << EffectType.reverb;
                                instrument.reverb = legacyGlobalReverb;
                            }
                        }
                    } else {
                        const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                        const vibrato: number = clamp(0, Config.vibratos.length + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        instrument.vibrato = vibrato;
                        if (instrument.vibrato != Config.vibratos.dictionary["none"].index) {
                            // Enable vibrato if it was used.
                            instrument.effects |= 1 << EffectType.vibrato;
                        }
                        // Custom vibrato
                        if (vibrato == Config.vibratos.length) {
                            instrument.vibratoDepth = clamp(0, Config.modulators.dictionary["vibrato depth"].maxRawVol + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]) / 50;
                            instrument.vibratoSpeed = clamp(0, Config.modulators.dictionary["vibrato speed"].maxRawVol + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            instrument.vibratoDelay = clamp(0, Config.modulators.dictionary["vibrato delay"].maxRawVol + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]) / 2;
                            instrument.vibratoType = clamp(0, Config.vibratoTypes.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            instrument.effects |= 1 << EffectType.vibrato;
                        }
                        // Enforce standard vibrato settings
                        else {
                            instrument.vibratoDepth = Config.vibratos[instrument.vibrato].amplitude;
                            instrument.vibratoSpeed = 10; // Normal speed
                            instrument.vibratoDelay = Config.vibratos[instrument.vibrato].delayTicks / 2;
                            instrument.vibratoType = Config.vibratos[instrument.vibrato].type;
                        }
                    }
                } else {
                    // songeq
                    if (fromJukeBox || (fromSlarmoosBox && !beforeFour)) { //double check that it's from a valid version
                        const originalControlPointCount: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        this.eqFilter.controlPointCount = clamp(0, Config.filterMaxPoints + 1, originalControlPointCount);
                        for (let i: number = this.eqFilter.controlPoints.length; i < this.eqFilter.controlPointCount; i++) {
                            this.eqFilter.controlPoints[i] = new FilterControlPoint();
                        }
                        for (let i: number = 0; i < this.eqFilter.controlPointCount; i++) {
                            const point: FilterControlPoint = this.eqFilter.controlPoints[i];
                            point.type = clamp(0, FilterType.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            point.freq = clamp(0, Config.filterFreqRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            point.gain = clamp(0, Config.filterGainRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        }
                        for (let i: number = this.eqFilter.controlPointCount; i < originalControlPointCount; i++) {
                            charIndex += 3;
                        }

                        // Get subfilters as well. Skip Index 0, is a copy of the base filter.
                        this.eqSubFilters[0] = this.eqFilter;
                        let usingSubFilterBitfield: number = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
                            if (usingSubFilterBitfield & (1 << j)) {
                                // Number of control points
                                const originalSubfilterControlPointCount: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                                if (this.eqSubFilters[j + 1] == null)
                                    this.eqSubFilters[j + 1] = new FilterSettings();
                                this.eqSubFilters[j + 1]!.controlPointCount = clamp(0, Config.filterMaxPoints + 1, originalSubfilterControlPointCount);
                                for (let i: number = this.eqSubFilters[j + 1]!.controlPoints.length; i < this.eqSubFilters[j + 1]!.controlPointCount; i++) {
                                    this.eqSubFilters[j + 1]!.controlPoints[i] = new FilterControlPoint();
                                }
                                for (let i: number = 0; i < this.eqSubFilters[j + 1]!.controlPointCount; i++) {
                                    const point: FilterControlPoint = this.eqSubFilters[j + 1]!.controlPoints[i];
                                    point.type = clamp(0, FilterType.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                    point.freq = clamp(0, Config.filterFreqRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                    point.gain = clamp(0, Config.filterGainRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                }
                                for (let i: number = this.eqSubFilters[j + 1]!.controlPointCount; i < originalSubfilterControlPointCount; i++) {
                                    charIndex += 3;
                                }
                            }
                        }
                    }
                }
            } break;
            case SongTagCode.arpeggioSpeed: {
                // Deprecated, but supported for legacy purposes
                if ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox)) {
                    const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    instrument.arpeggioSpeed = clamp(0, Config.modulators.dictionary["arp speed"].maxRawVol + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    instrument.fastTwoNoteArp = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] ? true : false; // Two note arp setting piggybacks on this
                }
                else {
                    // Do nothing, deprecated for now
                }
            } break;
            case SongTagCode.unison: {
                if (beforeThree && fromBeepBox) {
                    const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    const instrument = this.channels[channelIndex].instruments[0];
                    instrument.unison = clamp(0, Config.unisons.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    instrument.unisonVoices = Config.unisons[instrument.unison].voices;
                    instrument.unisonSpread = Config.unisons[instrument.unison].spread;
                    instrument.unisonOffset = Config.unisons[instrument.unison].offset;
                    instrument.unisonExpression = Config.unisons[instrument.unison].expression;
                    instrument.unisonSign = Config.unisons[instrument.unison].sign;
                } else if (beforeSix && fromBeepBox) {
                    for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                        for (const instrument of this.channels[channelIndex].instruments) {
                            const originalValue: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                            let unison: number = clamp(0, Config.unisons.length, originalValue);
                            if (originalValue == 8) {
                                // original "custom harmony" now maps to "hum" and "custom interval".
                                unison = 2;
                                instrument.chord = 3;
                            }
                            instrument.unison = unison;
                            instrument.unisonVoices = Config.unisons[instrument.unison].voices;
                            instrument.unisonSpread = Config.unisons[instrument.unison].spread;
                            instrument.unisonOffset = Config.unisons[instrument.unison].offset;
                            instrument.unisonExpression = Config.unisons[instrument.unison].expression;
                            instrument.unisonSign = Config.unisons[instrument.unison].sign;
                        }
                    }
                } else if (beforeSeven && fromBeepBox) {
                    const originalValue: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    let unison: number = clamp(0, Config.unisons.length, originalValue);
                    const instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    if (originalValue == 8) {
                        // original "custom harmony" now maps to "hum" and "custom interval".
                        unison = 2;
                        instrument.chord = 3;
                    }
                    instrument.unison = unison;
                    instrument.unisonVoices = Config.unisons[instrument.unison].voices;
                    instrument.unisonSpread = Config.unisons[instrument.unison].spread;
                    instrument.unisonOffset = Config.unisons[instrument.unison].offset;
                    instrument.unisonExpression = Config.unisons[instrument.unison].expression;
                    instrument.unisonSign = Config.unisons[instrument.unison].sign;
                } else {
                    const instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    instrument.unison = clamp(0, Config.unisons.length + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    const unisonLength = ((beforeFive || !fromSlarmoosBox) && !fromJukeBox) ? 27 : Config.unisons.length; //27 was the old length before I added >2 voice presets

                    if (((fromUltraBox && !beforeFive) || fromSlarmoosBox || fromJukeBox) && (instrument.unison == unisonLength)) {
                        
                        // if (instrument.unison == Config.unisons.length) {
                        instrument.unison = Config.unisons.length;
                        instrument.unisonVoices = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        const unisonSpreadNegative = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        const unisonSpread: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + ((base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 63)) * 63);

                        const unisonOffsetNegative = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        const unisonOffset: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + ((base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 63)) * 63);

                        const unisonExpressionNegative = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        const unisonExpression: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 63);

                        const unisonSignNegative = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        const unisonSign: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 63);


                        instrument.unisonSpread = unisonSpread / 1000;
                        if (unisonSpreadNegative == 0) instrument.unisonSpread *= -1;

                        instrument.unisonOffset = unisonOffset / 1000;
                        if (unisonOffsetNegative == 0) instrument.unisonOffset *= -1;

                        instrument.unisonExpression = unisonExpression / 1000;
                        if (unisonExpressionNegative == 0) instrument.unisonExpression *= -1;

                        instrument.unisonSign = unisonSign / 1000;
                        if (unisonSignNegative == 0) instrument.unisonSign *= -1;
                    } else {
                        instrument.unisonVoices = Config.unisons[instrument.unison].voices;
                        instrument.unisonSpread = Config.unisons[instrument.unison].spread;
                        instrument.unisonOffset = Config.unisons[instrument.unison].offset;
                        instrument.unisonExpression = Config.unisons[instrument.unison].expression;
                        instrument.unisonSign = Config.unisons[instrument.unison].sign;
                    }
                }

            } break;
            case SongTagCode.chord: {
                if ((beforeNine && fromBeepBox) || ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox))) {
                    const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    instrument.chord = clamp(0, Config.chords.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    if (instrument.chord != Config.chords.dictionary["simultaneous"].index) {
                        // Enable chord if it was used.
                        instrument.effects |= 1 << EffectType.chord;
                    }
                } else {
                    // Do nothing? This song tag code is deprecated for now.
                }
            } break;
            case SongTagCode.effects: {
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                if ((beforeNine && fromBeepBox) || ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox))) {
                    instrument.effects = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] & ((1 << EffectType.length) - 1));
                    if (legacyGlobalReverb == 0 && !((fromJummBox && beforeFive) || (beforeFour && fromGoldBox))) {
                        // Disable reverb if legacy song reverb was zero.
                        instrument.effects &= ~(1 << EffectType.reverb);
                    } else if (effectsIncludeReverb(instrument.effects)) {
                        instrument.reverb = legacyGlobalReverb;
                    }
                    // @jummbus - Enabling pan effect on song import no matter what to make it a default.
                    //if (instrument.pan != Config.panCenter) {
                    instrument.effects |= 1 << EffectType.panning;
                    //}
                    if (instrument.vibrato != Config.vibratos.dictionary["none"].index) {
                        // Enable vibrato if it was used.
                        instrument.effects |= 1 << EffectType.vibrato;
                    }
                    if (instrument.detune != Config.detuneCenter) {
                        // Enable detune if it was used.
                        instrument.effects |= 1 << EffectType.detune;
                    }
                    if (instrument.aliases)
                        instrument.effects |= 1 << EffectType.distortion;
                    else
                        instrument.effects &= ~(1 << EffectType.distortion);

                    // convertLegacySettings may need to force-enable note filter, call
                    // it again here to make sure that this override takes precedence.
                    const legacySettings: LegacySettings = legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
                    instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
                } else {
                    // BeepBox currently uses three base64 characters at 6 bits each for a bitfield representing all the enabled effects.
                    if (EffectType.length > 18) throw new Error();
                    if (fromJukeBox || (fromSlarmoosBox && !beforeFive)) {
                        instrument.effects = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 12) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    } else {
                        instrument.effects = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    }

                    if (effectsIncludeNoteFilter(instrument.effects)) {
                        let typeCheck: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        if (fromBeepBox || typeCheck == 0) {
                            instrument.noteFilterType = false;
                            if (fromJummBox || fromGoldBox || fromUltraBox || fromSlarmoosBox || fromJukeBox)
                                typeCheck = base64CharCodeToInt[compressed.charCodeAt(charIndex++)]; // Skip to next index in jummbox to get actual count
                            instrument.noteFilter.controlPointCount = clamp(0, Config.filterMaxPoints + 1, typeCheck);
                            for (let i: number = instrument.noteFilter.controlPoints.length; i < instrument.noteFilter.controlPointCount; i++) {
                                instrument.noteFilter.controlPoints[i] = new FilterControlPoint();
                            }
                            for (let i: number = 0; i < instrument.noteFilter.controlPointCount; i++) {
                                const point: FilterControlPoint = instrument.noteFilter.controlPoints[i];
                                point.type = clamp(0, FilterType.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                point.freq = clamp(0, Config.filterFreqRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                point.gain = clamp(0, Config.filterGainRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            }
                            for (let i: number = instrument.noteFilter.controlPointCount; i < typeCheck; i++) {
                                charIndex += 3;
                            }

                            // Get subfilters as well. Skip Index 0, is a copy of the base filter.
                            instrument.noteSubFilters[0] = instrument.noteFilter;
                            if ((fromJummBox && !beforeFive) || (fromGoldBox) || (fromUltraBox) || (fromSlarmoosBox) || fromJukeBox) {
                                let usingSubFilterBitfield: number = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
                                    if (usingSubFilterBitfield & (1 << j)) {
                                        // Number of control points
                                        const originalSubfilterControlPointCount: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                                        if (instrument.noteSubFilters[j + 1] == null)
                                            instrument.noteSubFilters[j + 1] = new FilterSettings();
                                        instrument.noteSubFilters[j + 1]!.controlPointCount = clamp(0, Config.filterMaxPoints + 1, originalSubfilterControlPointCount);
                                        for (let i: number = instrument.noteSubFilters[j + 1]!.controlPoints.length; i < instrument.noteSubFilters[j + 1]!.controlPointCount; i++) {
                                            instrument.noteSubFilters[j + 1]!.controlPoints[i] = new FilterControlPoint();
                                        }
                                        for (let i: number = 0; i < instrument.noteSubFilters[j + 1]!.controlPointCount; i++) {
                                            const point: FilterControlPoint = instrument.noteSubFilters[j + 1]!.controlPoints[i];
                                            point.type = clamp(0, FilterType.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                            point.freq = clamp(0, Config.filterFreqRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                            point.gain = clamp(0, Config.filterGainRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                        }
                                        for (let i: number = instrument.noteSubFilters[j + 1]!.controlPointCount; i < originalSubfilterControlPointCount; i++) {
                                            charIndex += 3;
                                        }
                                    }
                                }
                            }
                        } else {
                            instrument.noteFilterType = true;
                            instrument.noteFilter.reset();
                            instrument.noteFilterSimpleCut = clamp(0, Config.filterSimpleCutRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            instrument.noteFilterSimplePeak = clamp(0, Config.filterSimplePeakRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);

                        }
                    }
                    if (effectsIncludeTransition(instrument.effects)) {
                        instrument.transition = clamp(0, Config.transitions.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    }
                    if (effectsIncludeChord(instrument.effects)) {
                        instrument.chord = clamp(0, Config.chords.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        // Custom arpeggio speed... only in JB, and only if the instrument arpeggiates.
                        if (instrument.chord == Config.chords.dictionary["arpeggio"].index && (fromJummBox || fromGoldBox || fromUltraBox || fromSlarmoosBox || fromJukeBox)) {
                            instrument.arpeggioSpeed = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                            instrument.fastTwoNoteArp = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)]) ? true : false;
                        }
                        if (instrument.chord == Config.chords.dictionary["monophonic"].index && ((fromSlarmoosBox && !beforeFive) || fromJukeBox)) {
                            instrument.monoChordTone = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        }
                    }
                    if (effectsIncludePitchShift(instrument.effects)) {
                        instrument.pitchShift = clamp(0, Config.pitchShiftRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    }
                    if (effectsIncludeDetune(instrument.effects)) {
                        if (fromBeepBox) {
                            // Convert from BeepBox's formula
                            instrument.detune = clamp(Config.detuneMin, Config.detuneMax + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            instrument.detune = Math.round((instrument.detune - 9) * (Math.abs(instrument.detune - 9) + 1) / 2 + Config.detuneCenter);
                        } else {
                            instrument.detune = clamp(Config.detuneMin, Config.detuneMax + 1, (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        }
                    }
                    if (effectsIncludeVibrato(instrument.effects)) {
                        instrument.vibrato = clamp(0, Config.vibratos.length + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);

                        // Custom vibrato
                        if (instrument.vibrato == Config.vibratos.length && (fromJummBox || fromGoldBox || fromUltraBox || fromSlarmoosBox || fromJukeBox)) {
                            instrument.vibratoDepth = clamp(0, Config.modulators.dictionary["vibrato depth"].maxRawVol + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]) / 25;
                            instrument.vibratoSpeed = clamp(0, Config.modulators.dictionary["vibrato speed"].maxRawVol + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            instrument.vibratoDelay = clamp(0, Config.modulators.dictionary["vibrato delay"].maxRawVol + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                            instrument.vibratoType = clamp(0, Config.vibratoTypes.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        }
                        // Enforce standard vibrato settings
                        else {
                            instrument.vibratoDepth = Config.vibratos[instrument.vibrato].amplitude;
                            instrument.vibratoSpeed = 10; // Normal speed
                            instrument.vibratoDelay = Config.vibratos[instrument.vibrato].delayTicks / 2;
                            instrument.vibratoType = Config.vibratos[instrument.vibrato].type;
                        }
                    }
                    if (effectsIncludeDistortion(instrument.effects)) {
                        instrument.distortion = clamp(0, Config.distortionRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        if ((fromJummBox && !beforeFive) || fromGoldBox || fromUltraBox || fromSlarmoosBox || fromJukeBox)
                            instrument.aliases = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] ? true : false;
                    }
                    if (effectsIncludeBitcrusher(instrument.effects)) {
                        instrument.bitcrusherFreq = clamp(0, Config.bitcrusherFreqRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        instrument.bitcrusherQuantization = clamp(0, Config.bitcrusherQuantizationRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    }
                    
                    

                    if (effectsIncludePanning(instrument.effects)) {
                        if (fromBeepBox) {
                            // Beepbox has a panMax of 8 (9 total positions), Jummbox has a panMax of 100 (101 total positions)
                            instrument.pan = clamp(0, Config.panMax + 1, Math.round(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * ((Config.panMax) / 8.0)));
                        }
                        else {
                            instrument.pan = clamp(0, Config.panMax + 1, (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        }

                        // Now, pan delay follows on new versions of jummbox.
                        if ((fromJummBox && !beforeTwo) || fromGoldBox || fromUltraBox || fromSlarmoosBox || fromJukeBox)
                            instrument.panDelay = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    }
                    if (effectsIncludeChorus(instrument.effects)) {
                        if (fromBeepBox) {
                            // BeepBox has 4 chorus values vs. JB's 8
                            instrument.chorus = clamp(0, (Config.chorusRange / 2) + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]) * 2;
                        }
                        else {
                            instrument.chorus = clamp(0, Config.chorusRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        }
                    }
                    if (effectsIncludeEcho(instrument.effects)) {
                        instrument.echoSustain = clamp(0, Config.echoSustainRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        instrument.echoDelay = clamp(0, Config.echoDelayRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    }
                    if (effectsIncludeReverb(instrument.effects)) {
                        if (fromBeepBox) {
                            instrument.reverb = clamp(0, Config.reverbRange, Math.round(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * Config.reverbRange / 3.0));
                        } else {
                            instrument.reverb = clamp(0, Config.reverbRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        }
                    }
                    if (effectsIncludeGranular(instrument.effects)) {
                        instrument.granular = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        instrument.grainSize = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        instrument.grainAmounts = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        instrument.grainRange = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    }
                    if (effectsIncludeRingModulation(instrument.effects)) {
                        instrument.ringModulation = clamp(0, Config.ringModRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        instrument.ringModulationHz = clamp(0, Config.ringModHzRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        instrument.ringModWaveformIndex = clamp(0, Config.operatorWaves.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        instrument.ringModPulseWidth = clamp(0, Config.pulseWidthRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        instrument.ringModHzOffset = clamp(Config.rmHzOffsetMin, Config.rmHzOffsetMax + 1, (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    }
                    if (effectsIncludePhaser(instrument.effects)) {
                        instrument.phaserFreq = clamp(0, Config.phaserFreqRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        instrument.phaserFeedback = clamp(0, Config.phaserFeedbackRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        instrument.phaserStages = clamp(0, Config.phaserMaxStages + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]); 
                        instrument.phaserMix = clamp(0, Config.phaserMixRange, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    }
                    if(effectsIncludeInvertWave(instrument.effects)) {
                        instrument.invertWave = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] ? true : false;
                    }
                    if (effectsIncludeNoteRange(instrument.effects)) {
                        instrument.upperNoteLimit = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        instrument.lowerNoteLimit = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    }
                }
                // Clamp the range.
                instrument.effects &= (1 << EffectType.length) - 1;
            } break;
            case SongTagCode.samplePitchLock: {
                // BreakBox: flag is only written when true; value byte is 1.
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                instrument.samplePitchLock = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] != 0;
            } break;
            case SongTagCode.volume: {
                if (beforeThree && fromBeepBox) {
                    const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    const instrument: Instrument = this.channels[channelIndex].instruments[0];
                    instrument.volume = Math.round(clamp(-Config.volumeRange / 2, 1, -base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 5.0));
                } else if (beforeSix && fromBeepBox) {
                    for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                        for (const instrument of this.channels[channelIndex].instruments) {
                            instrument.volume = Math.round(clamp(-Config.volumeRange / 2, 1, -base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 5.0));
                        }
                    }
                } else if (beforeSeven && fromBeepBox) {
                    const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    instrument.volume = Math.round(clamp(-Config.volumeRange / 2, 1, -base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 5.0));
                } else if (fromBeepBox) {
                    // Beepbox v9's volume range is 0-7 (0 is max, 7 is mute)
                    const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    instrument.volume = Math.round(clamp(-Config.volumeRange / 2, 1, -base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 25.0 / 7.0));
                } else {
                    const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    // Volume is stored in two bytes in jummbox just in case range ever exceeds one byte, e.g. through later waffling on the subject.
                    instrument.volume = Math.round(clamp(-Config.volumeRange / 2, Config.volumeRange / 2 + 1, ((base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) | (base64CharCodeToInt[compressed.charCodeAt(charIndex++)])) - Config.volumeRange / 2));
                }
            } break;
            case SongTagCode.pan: {
                if (beforeNine && fromBeepBox) {
                    // Beepbox has a panMax of 8 (9 total positions), Jummbox has a panMax of 100 (101 total positions)
                    const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    instrument.pan = clamp(0, Config.panMax + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * ((Config.panMax) / 8.0));
                } else if ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox)) {
                    const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    instrument.pan = clamp(0, Config.panMax + 1, (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    // Pan delay follows on v3 + v4
                    if (fromJummBox && !beforeThree || fromGoldBox || fromUltraBox || fromSlarmoosBox || fromJukeBox) {
                        instrument.panDelay = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    }
                } else {
                    // Do nothing? This song tag code is deprecated for now.
                }
            } break;
            case SongTagCode.detune: {
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];

                if ((fromJummBox && beforeFive) || (beforeFour && fromGoldBox)) {
                    // Before jummbox v5, detune was -50 to 50. Now it is 0 to 400
                    instrument.detune = clamp(Config.detuneMin, Config.detuneMax + 1, ((base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)]) * 4);
                    instrument.effects |= 1 << EffectType.detune;
                } else {
                    // Now in v5, tag code is deprecated and handled thru detune effects.
                }
            } break;
            case SongTagCode.customChipWave: {
                let instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                // Pop custom wave values
                for (let j: number = 0; j < 64; j++) {
                    instrument.customChipWave[j]
                        = clamp(-24, 25, base64CharCodeToInt[compressed.charCodeAt(charIndex++)] - 24);
                }

                let sum: number = 0.0;
                for (let i: number = 0; i < instrument.customChipWave.length; i++) {
                    sum += instrument.customChipWave[i];
                }
                const average: number = sum / instrument.customChipWave.length;

                // Perform the integral on the wave. The chipSynth will perform the derivative to get the original wave back but with antialiasing.
                let cumulative: number = 0;
                let wavePrev: number = 0;
                for (let i: number = 0; i < instrument.customChipWave.length; i++) {
                    cumulative += wavePrev;
                    wavePrev = instrument.customChipWave[i] - average;
                    instrument.customChipWaveIntegral[i] = cumulative;
                }

                // 65th, last sample is for anti-aliasing
                instrument.customChipWaveIntegral[64] = 0.0;

            } break;
            case SongTagCode.limiterSettings: {
                let nextValue: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];

                // Check if limiter settings are used... if not, restore to default
                if (nextValue == 0x3f) {
                    this.restoreLimiterDefaults();
                }
                else {
                    // Limiter is used, grab values
                    this.compressionRatio = (nextValue < 10 ? nextValue / 10 : (1 + (nextValue - 10) / 60));
                    nextValue = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    this.limitRatio = (nextValue < 10 ? nextValue / 10 : (nextValue - 9));
                    this.limitDecay = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    this.limitRise = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 250.0) + 2000.0;
                    this.compressionThreshold = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] / 20.0;
                    this.limitThreshold = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] / 20.0;
                    this.masterGain = ((base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)]) / 50.0;
                }
            } break;
            case SongTagCode.channelNames: {
                for (let channel: number = 0; channel < this.getChannelCount(); channel++) {
                    // Length of channel name string. Due to some crazy Unicode characters this needs to be 2 bytes...
                    var channelNameLength;
                    if (beforeFour && !fromGoldBox && !fromUltraBox && !fromSlarmoosBox && !fromJukeBox)
                        channelNameLength = base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
                    else
                        channelNameLength = ((base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) + base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    this.channels[channel].name = decodeURIComponent(compressed.substring(charIndex, charIndex + channelNameLength));

                    charIndex += channelNameLength;
                }
            } break;
            case SongTagCode.algorithm: {
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                if (instrument.type == InstrumentType.fm) {
                    instrument.algorithm = clamp(0, Config.algorithms.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                }
                else {
                    instrument.algorithm6Op = clamp(0, Config.algorithms6Op.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    instrument.customAlgorithm.fromPreset(instrument.algorithm6Op);
                    if (compressed.charCodeAt(charIndex) == SongTagCode.chord) {
                        let carrierCountTemp = clamp(1, Config.operatorCount + 2 + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex + 1)]);
                        charIndex++
                        let tempModArray: number[][] = [];
                        if (compressed.charCodeAt(charIndex + 1) == SongTagCode.effects) {
                            charIndex++
                            let j: number = 0;
                            charIndex++
                            while (compressed.charCodeAt(charIndex) != SongTagCode.effects) {
                                tempModArray[j] = [];
                                let o: number = 0;
                                while (compressed.charCodeAt(charIndex) != SongTagCode.operatorWaves) {
                                    tempModArray[j][o] = clamp(1, Config.operatorCount + 3, base64CharCodeToInt[compressed.charCodeAt(charIndex)]);
                                    o++
                                    charIndex++
                                }
                                j++;
                                charIndex++
                            }
                            instrument.customAlgorithm.set(carrierCountTemp, tempModArray);
                            charIndex++; //????
                        }
                    }
                }
                if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox) || (beforeFour && fromGoldBox)) {
                    // The algorithm determines the carrier count, which affects how legacy settings are imported.
                    const legacySettings: LegacySettings = legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
                    instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
                }
            } break;
            case SongTagCode.supersaw: {
                if (fromGoldBox && !beforeFour && beforeSix) {
                    //is it more useful to save base64 characters or url length?
                    const chipWaveForCompat = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    if ((chipWaveForCompat + 62) > 85) {
                        if (document.URL.substring(document.URL.length - 13).toLowerCase() != "legacysamples") {
                            if (!willLoadLegacySamplesForOldSongs) {
                                willLoadLegacySamplesForOldSongs = true;
                                Config.willReloadForCustomSamples = true;
                                EditorConfig.customSamples = ["legacySamples"];
                                loadBuiltInSamples(0);
                            }
                        }
                    }

                    if ((chipWaveForCompat + 62) > 78) {
                        this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipWave = clamp(0, Config.chipWaves.length, chipWaveForCompat + 63);
                    }
                    else if ((chipWaveForCompat + 62) > 67) {
                        this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipWave = clamp(0, Config.chipWaves.length, chipWaveForCompat + 61);
                    }
                    else if ((chipWaveForCompat + 62) == 67) {
                        this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipWave = 40;
                    }
                    else {
                        this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipWave = clamp(0, Config.chipWaves.length, chipWaveForCompat + 62);
                    }
                } else {
                    const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    instrument.supersawDynamism = clamp(0, Config.supersawDynamismMax + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    instrument.supersawSpread = clamp(0, Config.supersawSpreadMax + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    instrument.supersawShape = clamp(0, Config.supersawShapeMax + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                }
            } break;
            case SongTagCode.feedbackType: {
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                if (instrument.type == InstrumentType.fm) {
                    instrument.feedbackType = clamp(0, Config.feedbacks.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                }
                else {
                    instrument.feedbackType6Op = clamp(0, Config.feedbacks6Op.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    instrument.customFeedbackType.fromPreset(instrument.feedbackType6Op);
                    let tempModArray: number[][] = [];
                    if (compressed.charCodeAt(charIndex) == SongTagCode.effects) {
                        let j: number = 0;
                        charIndex++
                        while (compressed.charCodeAt(charIndex) != SongTagCode.effects) {
                            tempModArray[j] = [];
                            let o: number = 0;
                            while (compressed.charCodeAt(charIndex) != SongTagCode.operatorWaves) {
                                tempModArray[j][o] = clamp(1, Config.operatorCount + 2, base64CharCodeToInt[compressed.charCodeAt(charIndex)]);
                                o++
                                charIndex++
                            }
                            j++;
                            charIndex++
                        }
                        instrument.customFeedbackType.set(tempModArray);
                        charIndex++; //???? weirdly needs to skip the end character or it'll use that next loop instead of like just moving to the next one itself
                    }
                }

            } break;
            case SongTagCode.feedbackAmplitude: {
                this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].feedbackAmplitude = clamp(0, Config.operatorAmplitudeMax + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
            } break;
            case SongTagCode.feedbackEnvelope: {
                if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox) || (beforeFour && fromGoldBox)) {
                    const pregoldToEnvelope: number[] = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18, 19, 20, 21, 23, 24, 25, 27, 28, 29, 32, 33, 34, 31, 11];
                    const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    const legacySettings: LegacySettings = legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];

                    let aa: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    if ((beforeTwo && fromGoldBox) || (!fromGoldBox && !fromUltraBox && !fromSlarmoosBox && !fromJukeBox)) aa = pregoldToEnvelope[aa];
                    legacySettings.feedbackEnvelope = Song._envelopeFromLegacyIndex(base64CharCodeToInt[aa]);
                    instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
                } else {
                    // Do nothing? This song tag code is deprecated for now.
                }
            } break;
            case SongTagCode.operatorFrequencies: {
                const instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                if (beforeThree && fromGoldBox) {
                    const freqToGold3 = [4, 5, 6, 7, 8, 10, 12, 13, 14, 15, 16, 18, 20, 22, 24, 2, 1, 9, 17, 19, 21, 23, 0, 3];

                    for (let o = 0; o < (instrument.type == InstrumentType.fm6op ? 6 : Config.operatorCount); o++) {
                        instrument.operators[o].frequency = freqToGold3[clamp(0, freqToGold3.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)])];
                    }
                }
                else if (!fromGoldBox && !fromUltraBox && !fromSlarmoosBox && !fromJukeBox) {
                    const freqToUltraBox = [4, 5, 6, 7, 8, 10, 12, 13, 14, 15, 16, 18, 20, 23, 27, 2, 1, 9, 17, 19, 21, 23, 0, 3];

                    for (let o = 0; o < (instrument.type == InstrumentType.fm6op ? 6 : Config.operatorCount); o++) {
                        instrument.operators[o].frequency = freqToUltraBox[clamp(0, freqToUltraBox.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)])];
                    }

                }
                else {
                    for (let o = 0; o < (instrument.type == InstrumentType.fm6op ? 6 : Config.operatorCount); o++) {
                        instrument.operators[o].frequency = clamp(0, Config.operatorFrequencies.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    }
                }
            } break;
            case SongTagCode.operatorAmplitudes: {
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                for (let o: number = 0; o < (instrument.type == InstrumentType.fm6op ? 6 : Config.operatorCount); o++) {
                    instrument.operators[o].amplitude = clamp(0, Config.operatorAmplitudeMax + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                }
            } break;
            case SongTagCode.envelopes: {
                const pregoldToEnvelope: number[] = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18, 19, 20, 21, 23, 24, 25, 27, 28, 29, 32, 33, 34, 31, 11];
                const jummToUltraEnvelope: number[] = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18, 19, 20, 21, 23, 24, 25, 58, 59, 60];
                const slarURL3toURL4Envelope: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14];
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox) || (beforeFour && fromGoldBox)) {
                    const legacySettings: LegacySettings = legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
                    legacySettings.operatorEnvelopes = [];
                    for (let o: number = 0; o < (instrument.type == InstrumentType.fm6op ? 6 : Config.operatorCount); o++) {
                        let aa: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        if ((beforeTwo && fromGoldBox) || (fromBeepBox)) aa = pregoldToEnvelope[aa];
                        if (fromJummBox) aa = jummToUltraEnvelope[aa];
                        legacySettings.operatorEnvelopes[o] = Song._envelopeFromLegacyIndex(aa);
                    }
                    instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
                } else {
                    const envelopeCount: number = clamp(0, Config.maxEnvelopeCount + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    // JB v6 adds some envelope options here in the sequence.
                    let envelopeDiscrete: boolean = false;
                    if ((fromJummBox && !beforeSix) || (fromUltraBox && !beforeFive) || (fromSlarmoosBox) || fromJukeBox) {
                        instrument.envelopeSpeed = clamp(0, Config.modulators.dictionary["envelope speed"].maxRawVol + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        if ((!fromSlarmoosBox || beforeFive) && !fromJukeBox) {
                            envelopeDiscrete = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)]) ? true : false;
                        }
                    }
                    for (let i: number = 0; i < envelopeCount; i++) {
                        const target: number = clamp(0, Config.instrumentAutomationTargets.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        let index: number = 0;
                        const maxCount: number = Config.instrumentAutomationTargets[target].maxCount;
                        if (maxCount > 1) {
                            index = clamp(0, maxCount, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        }
                        let aa: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        if ((beforeTwo && fromGoldBox) || (fromBeepBox)) aa = pregoldToEnvelope[aa];
                        if (fromJummBox) aa = jummToUltraEnvelope[aa];
                        if (!fromJukeBox && !fromSlarmoosBox && aa >= 2) aa++; //2 for pitch
                        let updatedEnvelopes: boolean = false;
                        let perEnvelopeSpeed: number = 1;
                        if (!fromJukeBox && (!fromSlarmoosBox || beforeThree)) {
                            updatedEnvelopes = true;
                            perEnvelopeSpeed = Config.envelopes[aa].speed;
                            aa = Config.envelopes[aa].type; //update envelopes
                        } else if (!fromJukeBox && beforeFour && aa >= 3) aa++; //3 for random
                        let isTremolo2: boolean = false;
                        if ((fromSlarmoosBox && !beforeThree && beforeFour) || updatedEnvelopes) { //remove tremolo2
                            if (aa == 9) isTremolo2 = true;
                            aa = slarURL3toURL4Envelope[aa];
                        }
                        const envelope: number = clamp(0, ((fromJukeBox || (fromSlarmoosBox && !beforeThree) || updatedEnvelopes) ? Config.newEnvelopes.length : Config.envelopes.length), aa);
                        let pitchEnvelopeStart: number = 0;
                        let pitchEnvelopeEnd: number = Config.maxPitch;
                        let envelopeInverse: boolean = false;
                        perEnvelopeSpeed = (fromJukeBox || (fromSlarmoosBox && !beforeThree)) ? Config.newEnvelopes[envelope].speed : perEnvelopeSpeed;
                        let perEnvelopeLowerBound: number = 0;
                        let perEnvelopeUpperBound: number = 1;
                        let steps: number = 2;
                        let seed: number = 2;
                        let waveform: number = LFOEnvelopeTypes.sine;
                        //pull out unique envelope setting values first, then general ones
                        if (fromJukeBox || (fromSlarmoosBox && !beforeFour)) {
                            if (Config.newEnvelopes[envelope].name == "lfo") {
                                waveform = clamp(0, LFOEnvelopeTypes.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                if (waveform == LFOEnvelopeTypes.steppedSaw || waveform == LFOEnvelopeTypes.steppedTri) {
                                    steps = clamp(1, Config.randomEnvelopeStepsMax + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                }
                            } else if (Config.newEnvelopes[envelope].name == "random") {
                                steps = clamp(1, Config.randomEnvelopeStepsMax + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                seed = clamp(1, Config.randomEnvelopeSeedMax + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                waveform = clamp(0, RandomEnvelopeTypes.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]); //we use waveform for the random type as well
                            }
                        }
                        if (fromJukeBox || (fromSlarmoosBox && !beforeThree)) {
                            if (Config.newEnvelopes[envelope].name == "pitch") {
                                if (!instrument.isNoiseInstrument) {
                                    let pitchEnvelopeCompact: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                                    pitchEnvelopeStart = clamp(0, Config.maxPitch + 1, pitchEnvelopeCompact * 64 + base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                    pitchEnvelopeCompact = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                                    pitchEnvelopeEnd = clamp(0, Config.maxPitch + 1, pitchEnvelopeCompact * 64 + base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                } else {
                                    pitchEnvelopeStart = clamp(0, Config.drumCount, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                    pitchEnvelopeEnd = clamp(0, Config.drumCount, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                                }
                            }
                            let checkboxValues: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                            if (fromJukeBox || (fromSlarmoosBox && !beforeFive)) {
                                envelopeDiscrete = (checkboxValues >> 1) == 1 ? true : false;
                            }
                            envelopeInverse = (checkboxValues & 1) == 1 ? true : false;
                            if (Config.newEnvelopes[envelope].name != "pitch" && Config.newEnvelopes[envelope].name != "note size" && Config.newEnvelopes[envelope].name != "punch" && Config.newEnvelopes[envelope].name != "none") {
                                perEnvelopeSpeed = Config.perEnvelopeSpeedIndices[base64CharCodeToInt[compressed.charCodeAt(charIndex++)]];
                            }
                            perEnvelopeLowerBound = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] / 10;
                            perEnvelopeUpperBound = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] / 10;
                        }
                        if ((!fromSlarmoosBox && !fromJukeBox) || beforeFour) { //update tremolo2
                            if (isTremolo2) {
                                waveform = LFOEnvelopeTypes.sine;
                                if (envelopeInverse) {
                                    perEnvelopeUpperBound = Math.floor((perEnvelopeUpperBound / 2) * 10) / 10;
                                    perEnvelopeLowerBound = Math.floor((perEnvelopeLowerBound / 2) * 10) / 10;
                                } else {
                                    perEnvelopeUpperBound = Math.floor((0.5 + (perEnvelopeUpperBound - perEnvelopeLowerBound) / 2) * 10) / 10;
                                    perEnvelopeLowerBound = 0.5;
                                }
                            }
                        }

                        instrument.addEnvelope(target, index, envelope, true, pitchEnvelopeStart, pitchEnvelopeEnd, envelopeInverse, perEnvelopeSpeed, perEnvelopeLowerBound, perEnvelopeUpperBound, steps, seed, waveform, envelopeDiscrete);
                        if (fromSlarmoosBox && beforeThree && !beforeTwo) {
                            let pitchEnvelopeCompact: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                            instrument.envelopes[i].pitchEnvelopeStart = pitchEnvelopeCompact * 64 + base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                            pitchEnvelopeCompact = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                            instrument.envelopes[i].pitchEnvelopeEnd = pitchEnvelopeCompact * 64 + base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                            instrument.envelopes[i].inverse = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] == 1 ? true : false;
                        }
                    }

                    let instrumentPitchEnvelopeStart: number = 0;
                    let instrumentPitchEnvelopeEnd: number = Config.maxPitch;
                    let instrumentEnvelopeInverse: boolean = false;
                    if (fromSlarmoosBox && beforeTwo) {
                        let pitchEnvelopeCompact: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        instrumentPitchEnvelopeStart = pitchEnvelopeCompact * 64 + base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        pitchEnvelopeCompact = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        instrumentPitchEnvelopeEnd = pitchEnvelopeCompact * 64 + base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        instrumentEnvelopeInverse = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] === 1 ? true : false;
                        for (let i: number = 0; i < envelopeCount; i++) {
                            instrument.envelopes[i].pitchEnvelopeStart = instrumentPitchEnvelopeStart;
                            instrument.envelopes[i].pitchEnvelopeEnd = instrumentPitchEnvelopeEnd;
                            instrument.envelopes[i].inverse = Config.envelopes[instrument.envelopes[i].envelope].name == "pitch" ? instrumentEnvelopeInverse : false;
                        }
                    }

                }
            } break;
            case SongTagCode.operatorWaves: {
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];

                if (beforeThree && fromGoldBox) {
                    for (let o: number = 0; o < Config.operatorCount; o++) {
                        const pre3To3g = [0, 1, 3, 2, 2, 2, 4, 5];
                        const old: number = clamp(0, pre3To3g.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        if (old == 3) {
                            instrument.operators[o].pulseWidth = 5;
                        } else if (old == 4) {
                            instrument.operators[o].pulseWidth = 4;
                        } else if (old == 5) {
                            instrument.operators[o].pulseWidth = 6;
                        }
                        instrument.operators[o].waveform = pre3To3g[old];
                    }
                } else {
                    for (let o: number = 0; o < (instrument.type == InstrumentType.fm6op ? 6 : Config.operatorCount); o++) {
                        if (fromJummBox) {
                            const jummToG = [0, 1, 3, 2, 4, 5];
                            instrument.operators[o].waveform = jummToG[clamp(0, Config.operatorWaves.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)])];
                        } else {
                            instrument.operators[o].waveform = clamp(0, Config.operatorWaves.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        }
                        // Pulse width follows, if it is a pulse width operator wave
                        if (instrument.operators[o].waveform == 2) {
                            instrument.operators[o].pulseWidth = clamp(0, Config.pwmOperatorWaves.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                        }
                    }
                }

            } break;
            case SongTagCode.spectrum: {
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                if (instrument.type == InstrumentType.spectrum) {
                    const byteCount: number = Math.ceil(Config.spectrumControlPoints * Config.spectrumControlPointBits / 6)
                    const bits: BitFieldReader = new BitFieldReader(compressed, charIndex, charIndex + byteCount);
                    for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
                        instrument.spectrumWave.spectrum[i] = bits.read(Config.spectrumControlPointBits);
                    }
                    instrument.spectrumWave.markCustomWaveDirty();
                    charIndex += byteCount;
                } else if (instrument.type == InstrumentType.drumset) {
                    const byteCount: number = Math.ceil(Config.drumCount * Config.spectrumControlPoints * Config.spectrumControlPointBits / 6)
                    const bits: BitFieldReader = new BitFieldReader(compressed, charIndex, charIndex + byteCount);
                    for (let j: number = 0; j < Config.drumCount; j++) {
                        for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
                            instrument.drumsetSpectrumWaves[j].spectrum[i] = bits.read(Config.spectrumControlPointBits);
                        }
                        instrument.drumsetSpectrumWaves[j].markCustomWaveDirty();
                    }
                    charIndex += byteCount;
                } else {
                    throw new Error("Unhandled instrument type for spectrum song tag code.");
                }
            } break;
            case SongTagCode.harmonics: {
                const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                const byteCount: number = Math.ceil(Config.harmonicsControlPoints * Config.harmonicsControlPointBits / 6);
                const bits: BitFieldReader = new BitFieldReader(compressed, charIndex, charIndex + byteCount);
                for (let i: number = 0; i < Config.harmonicsControlPoints; i++) {
                    instrument.harmonicsWave.harmonics[i] = bits.read(Config.harmonicsControlPointBits);
                }
                instrument.harmonicsWave.markCustomWaveDirty();
                charIndex += byteCount;
            } break;
            case SongTagCode.aliases: {
                if ((fromJummBox && beforeFive) || (fromGoldBox && beforeFour)) {
                    const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                    instrument.aliases = (base64CharCodeToInt[compressed.charCodeAt(charIndex++)]) ? true : false;
                    if (instrument.aliases) {
                        instrument.distortion = 0;
                        instrument.effects |= 1 << EffectType.distortion;
                    }
                } else {
                    if (fromUltraBox || fromSlarmoosBox || fromJukeBox) {
                        const instrument: Instrument = this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
                        instrument.decimalOffset = clamp(0, 50 + 1, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    }
                }
            }
                break;
            case SongTagCode.bars: {
                let subStringLength: number;
                if (beforeThree && fromBeepBox) {
                    const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    const barCount: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    subStringLength = Math.ceil(barCount * 0.5);
                    const bits: BitFieldReader = new BitFieldReader(compressed, charIndex, charIndex + subStringLength);
                    for (let i: number = 0; i < barCount; i++) {
                        this.channels[channelIndex].bars[i] = bits.read(3) + 1;
                    }
                } else if (beforeFive && fromBeepBox) {
                    let neededBits: number = 0;
                    while ((1 << neededBits) < this.patternsPerChannel) neededBits++;
                    subStringLength = Math.ceil(this.getChannelCount() * this.barCount * neededBits / 6);
                    const bits: BitFieldReader = new BitFieldReader(compressed, charIndex, charIndex + subStringLength);
                    for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                        for (let i: number = 0; i < this.barCount; i++) {
                            this.channels[channelIndex].bars[i] = bits.read(neededBits) + 1;
                        }
                    }
                } else {
                    let neededBits: number = 0;
                    while ((1 << neededBits) < this.patternsPerChannel + 1) neededBits++;
                    subStringLength = Math.ceil(this.getChannelCount() * this.barCount * neededBits / 6);
                    const bits: BitFieldReader = new BitFieldReader(compressed, charIndex, charIndex + subStringLength);
                    for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
                        for (let i: number = 0; i < this.barCount; i++) {
                            this.channels[channelIndex].bars[i] = bits.read(neededBits);
                        }
                    }
                }
                charIndex += subStringLength;
            } break;
            case SongTagCode.patterns: {
                let bitStringLength: number = 0;
                let channelIndex: number;
                let largerChords: boolean = !((beforeFour && fromJummBox) || fromBeepBox);
                let recentPitchBitLength: number = (largerChords ? 4 : 3);
                let recentPitchLength: number = (largerChords ? 16 : 8);
                if (beforeThree && fromBeepBox) {
                    channelIndex = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];

                    // The old format used the next character to represent the number of patterns in the channel, which is usually eight, the default. 
                    charIndex++; //let patternCount: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];

                    bitStringLength = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                    bitStringLength = bitStringLength << 6;
                    bitStringLength += base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                } else {
                    channelIndex = 0;
                    let bitStringLengthLength: number = validateRange(1, 4, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
                    while (bitStringLengthLength > 0) {
                        bitStringLength = bitStringLength << 6;
                        bitStringLength += base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
                        bitStringLengthLength--;
                    }
                }

                const bits: BitFieldReader = new BitFieldReader(compressed, charIndex, charIndex + bitStringLength);
                charIndex += bitStringLength;

                const bitsPerNoteSize: number = Song.getNeededBits(Config.noteSizeMax);
                let songReverbChannel: number = -1;
                let songReverbInstrument: number = -1;
                let songReverbIndex: number = -1;

                //TODO: Goldbox detecting (ultrabox used the goldbox tag for a bit, sadly making things more complicated)
                const shouldCorrectTempoMods: boolean = fromJummBox;
                const jummboxTempoMin: number = 30;

                while (true) {
                    const channel: Channel = this.channels[channelIndex];
                    const isNoiseChannel: boolean = this.getChannelIsNoise(channelIndex);
                    const isModChannel: boolean = this.getChannelIsMod(channelIndex);

                    const maxInstrumentsPerPattern: number = this.getMaxInstrumentsPerPattern(channelIndex);
                    const neededInstrumentCountBits: number = Song.getNeededBits(maxInstrumentsPerPattern - Config.instrumentCountMin);

                    const neededInstrumentIndexBits: number = Song.getNeededBits(channel.instruments.length - 1);

                    // Some info about modulator settings immediately follows in mod channels.
                    if (isModChannel) {
                        let jumfive: boolean = (beforeFive && fromJummBox) || (beforeFour && fromGoldBox)

                        // 2 more indices for 'all' and 'active'
                        const neededModInstrumentIndexBits: number = (jumfive) ? neededInstrumentIndexBits : Song.getNeededBits(this.getMaxInstrumentsPerChannel() + 2);

                        for (let instrumentIndex: number = 0; instrumentIndex < channel.instruments.length; instrumentIndex++) {

                            let instrument: Instrument = channel.instruments[instrumentIndex];

                            for (let mod: number = 0; mod < Config.modCount; mod++) {
                                // Still using legacy "mod status" format, but doing it manually as it's only used in the URL now.
                                // 0 - For pitch/noise
                                // 1 - (used to be For noise, not needed)
                                // 2 - For song
                                // 3 - None
                                let status: number = bits.read(2);

                                switch (status) {
                                    case 0: // Pitch
                                        instrument.modChannels[mod] = clamp(0, this.pitchChannelCount + this.noiseChannelCount + 1, bits.read(8));
                                        instrument.modInstruments[mod] = clamp(0, this.channels[instrument.modChannels[mod]].instruments.length + 2, bits.read(neededModInstrumentIndexBits));
                                        break;
                                    case 1: // Noise
                                        // Getting a status of 1 means this is legacy mod info. Need to add pitch channel count, as it used to just store noise channel index and not overall channel index
                                        instrument.modChannels[mod] = this.pitchChannelCount + clamp(0, this.noiseChannelCount + 1, bits.read(8));
                                        instrument.modInstruments[mod] = clamp(0, this.channels[instrument.modChannels[mod]].instruments.length + 2, bits.read(neededInstrumentIndexBits));
                                        break;
                                    case 2: // For song
                                        instrument.modChannels[mod] = -1;
                                        break;
                                    case 3: // None
                                        instrument.modChannels[mod] = -2;
                                        break;
                                }

                                // Mod setting is only used if the status isn't "none".
                                if (status != 3) {
                                    instrument.modulators[mod] = bits.read(6);
                                }

                                if (!jumfive && (Config.modulators[instrument.modulators[mod]].name == "eq filter" || Config.modulators[instrument.modulators[mod]].name == "note filter" || Config.modulators[instrument.modulators[mod]].name == "song eq")) {
                                    instrument.modFilterTypes[mod] = bits.read(6);
                                }

                                if (Config.modulators[instrument.modulators[mod]].name == "individual envelope speed" ||
                                    Config.modulators[instrument.modulators[mod]].name == "reset envelope" ||
                                    Config.modulators[instrument.modulators[mod]].name == "individual envelope lower bound" ||
                                    Config.modulators[instrument.modulators[mod]].name == "individual envelope upper bound"
                                ) {
                                    instrument.modEnvelopeNumbers[mod] = bits.read(6);
                                }

                                if (jumfive && instrument.modChannels[mod] >= 0) {
                                    let forNoteFilter: boolean = effectsIncludeNoteFilter(this.channels[instrument.modChannels[mod]].instruments[instrument.modInstruments[mod]].effects);

                                    // For legacy filter cut/peak, need to denote since scaling must be applied
                                    if (instrument.modulators[mod] == 7) {
                                        // Legacy filter cut index
                                        // Check if there is no filter dot on prospective filter. If so, add a low pass at max possible freq.

                                        if (forNoteFilter) {
                                            instrument.modulators[mod] = Config.modulators.dictionary["note filt cut"].index;
                                        }
                                        else {
                                            instrument.modulators[mod] = Config.modulators.dictionary["eq filt cut"].index;
                                        }

                                        instrument.modFilterTypes[mod] = 1; // Dot 1 X

                                    }
                                    else if (instrument.modulators[mod] == 8) {
                                        // Legacy filter peak index
                                        if (forNoteFilter) {
                                            instrument.modulators[mod] = Config.modulators.dictionary["note filt peak"].index;
                                        }
                                        else {
                                            instrument.modulators[mod] = Config.modulators.dictionary["eq filt peak"].index;
                                        }

                                        instrument.modFilterTypes[mod] = 2; // Dot 1 Y
                                    }
                                }
                                else if (jumfive) {
                                    // Check for song reverb mod, which must be handled differently now that it is a multiplier
                                    if (instrument.modulators[mod] == Config.modulators.dictionary["song reverb"].index) {
                                        songReverbChannel = channelIndex;
                                        songReverbInstrument = instrumentIndex;
                                        songReverbIndex = mod;
                                    }
                                }

                                // Based on setting, enable some effects for the modulated instrument. This isn't always set, say if the instrument's pan was right in the center.
                                // Only used on import of old songs, because sometimes an invalid effect can be set in a mod in the new version that is actually unused. In that case,
                                // keeping the mod invalid is better since it preserves the state.
                                if (jumfive && Config.modulators[instrument.modulators[mod]].associatedEffect != EffectType.length) {
                                    this.channels[instrument.modChannels[mod]].instruments[instrument.modInstruments[mod]].effects |= 1 << Config.modulators[instrument.modulators[mod]].associatedEffect;
                                }
                            }
                        }
                    }

                    // Scalar applied to detune mods since its granularity was upped. Could be repurposed later if any other granularity changes occur.
                    const detuneScaleNotes: number[][] = [];
                    for (let j: number = 0; j < channel.instruments.length; j++) {
                        detuneScaleNotes[j] = [];
                        for (let i: number = 0; i < Config.modCount; i++) {
                            detuneScaleNotes[j][Config.modCount - 1 - i] = 1 + 3 * +(((beforeFive && fromJummBox) || (beforeFour && fromGoldBox)) && isModChannel && (channel.instruments[j].modulators[i] == Config.modulators.dictionary["detune"].index));
                        }
                    }
                    const octaveOffset: number = (isNoiseChannel || isModChannel) ? 0 : channel.octave * 12;
                    let lastPitch: number = ((isNoiseChannel || isModChannel) ? 4 : octaveOffset);
                    const recentPitches: number[] = isModChannel ? [0, 1, 2, 3, 4, 5] : (isNoiseChannel ? [4, 6, 7, 2, 3, 8, 0, 10] : [0, 7, 12, 19, 24, -5, -12]);
                    const recentShapes: any[] = [];
                    for (let i: number = 0; i < recentPitches.length; i++) {
                        recentPitches[i] += octaveOffset;
                    }
                    for (let i: number = 0; i < this.patternsPerChannel; i++) {
                        const newPattern: Pattern = channel.patterns[i];

                        if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox) || (beforeFour && fromGoldBox)) {
                            newPattern.instruments[0] = validateRange(0, channel.instruments.length - 1, bits.read(neededInstrumentIndexBits));
                            newPattern.instruments.length = 1;
                        } else {
                            if (this.patternInstruments) {
                                const instrumentCount: number = validateRange(Config.instrumentCountMin, maxInstrumentsPerPattern, bits.read(neededInstrumentCountBits) + Config.instrumentCountMin);
                                for (let j: number = 0; j < instrumentCount; j++) {
                                    newPattern.instruments[j] = validateRange(0, channel.instruments.length - 1 + +(isModChannel) * 2, bits.read(neededInstrumentIndexBits));
                                }
                                newPattern.instruments.length = instrumentCount;
                            } else {
                                newPattern.instruments[0] = 0;
                                newPattern.instruments.length = Config.instrumentCountMin;
                            }
                        }

                        if (!(fromBeepBox && beforeThree) && bits.read(1) == 0) {
                            newPattern.notes.length = 0;
                            continue;
                        }

                        let curPart: number = 0;
                        const newNotes: Note[] = newPattern.notes;
                        let noteCount: number = 0;
                        // Due to arbitrary note positioning, mod channels don't end the count until curPart actually exceeds the max
                        while (curPart < this.beatsPerBar * Config.partsPerBeat + (+isModChannel)) {

                            const useOldShape: boolean = bits.read(1) == 1;
                            let newNote: boolean = false;
                            let shapeIndex: number = 0;
                            if (useOldShape) {
                                shapeIndex = validateRange(0, recentShapes.length - 1, bits.readLongTail(0, 0));
                            } else {
                                newNote = bits.read(1) == 1;
                            }

                            if (!useOldShape && !newNote) {
                                // For mod channels, check if you need to move backward too (notes can appear in any order and offset from each other).
                                if (isModChannel) {
                                    const isBackwards: boolean = bits.read(1) == 1;
                                    const restLength: number = bits.readPartDuration();
                                    if (isBackwards) {
                                        curPart -= restLength;
                                    }
                                    else {
                                        curPart += restLength;
                                    }
                                } else {
                                    const restLength: number = (beforeSeven && fromBeepBox)
                                        ? bits.readLegacyPartDuration() * Config.partsPerBeat / Config.rhythms[this.rhythm].stepsPerBeat
                                        : bits.readPartDuration();
                                    curPart += restLength;

                                }
                            } else {
                                let shape: any;
                                if (useOldShape) {
                                    shape = recentShapes[shapeIndex];
                                    recentShapes.splice(shapeIndex, 1);
                                } else {
                                    shape = {};

                                    if (!largerChords) {
                                        // Old format: X 1's followed by a 0 => X+1 pitches, up to 4
                                        shape.pitchCount = 1;
                                        while (shape.pitchCount < 4 && bits.read(1) == 1) shape.pitchCount++;
                                    }
                                    else {
                                        // New format is:
                                        //      0: 1 pitch
                                        // 1[XXX]: 3 bits of binary signifying 2+ pitches
                                        if (bits.read(1) == 1) {
                                            shape.pitchCount = bits.read(3) + 2;
                                        }
                                        else {
                                            shape.pitchCount = 1;
                                        }
                                    }

                                    shape.pinCount = bits.readPinCount();
                                    if (fromBeepBox) {
                                        shape.initialSize = bits.read(2) * 2;
                                    } else if (!isModChannel) {
                                        shape.initialSize = bits.read(bitsPerNoteSize);
                                    } else if (fromJukeBox && !beforeThree) {
                                        shape.initialSize = bits.read(11); //mod channels use 11 bits for 2000 tempo now
                                    } else {
                                        shape.initialSize = bits.read(9);
                                    }

                                    shape.pins = [];
                                    shape.length = 0;
                                    shape.bendCount = 0;
                                    for (let j: number = 0; j < shape.pinCount; j++) {
                                        let pinObj: any = {};
                                        pinObj.pitchBend = bits.read(1) == 1;
                                        if (pinObj.pitchBend) shape.bendCount++;
                                        shape.length += (beforeSeven && fromBeepBox)
                                            ? bits.readLegacyPartDuration() * Config.partsPerBeat / Config.rhythms[this.rhythm].stepsPerBeat
                                            : bits.readPartDuration();
                                        pinObj.time = shape.length;
                                        if (fromBeepBox) {
                                            pinObj.size = bits.read(2) * 2;
                                        } else if (!isModChannel) {
                                            pinObj.size = bits.read(bitsPerNoteSize);
                                        } else if (fromJukeBox && !beforeThree) {
                                            pinObj.size = bits.read(11); //mod channels use 11 bits for 2000 tempo now
                                        } else {
                                            pinObj.size = bits.read(9);
                                        }
                                        shape.pins.push(pinObj);
                                    }
                                }
                                recentShapes.unshift(shape);
                                if (recentShapes.length > 10) recentShapes.pop(); // TODO: Use Deque?

                                let note: Note;
                                if (newNotes.length <= noteCount) {
                                    note = new Note(0, curPart, curPart + shape.length, shape.initialSize);
                                    newNotes[noteCount++] = note;
                                } else {
                                    note = newNotes[noteCount++];
                                    note.start = curPart;
                                    note.end = curPart + shape.length;
                                    note.pins[0].size = shape.initialSize;
                                }

                                let pitch: number;
                                let pitchCount: number = 0;
                                const pitchBends: number[] = []; // TODO: allocate this array only once! keep separate length and iterator index. Use Deque?
                                for (let j: number = 0; j < shape.pitchCount + shape.bendCount; j++) {
                                    const useOldPitch: boolean = bits.read(1) == 1;
                                    if (!useOldPitch) {
                                        const interval: number = bits.readPitchInterval();
                                        pitch = lastPitch;
                                        let intervalIter: number = interval;
                                        while (intervalIter > 0) {
                                            pitch++;
                                            while (recentPitches.indexOf(pitch) != -1) pitch++;
                                            intervalIter--;
                                        }
                                        while (intervalIter < 0) {
                                            pitch--;
                                            while (recentPitches.indexOf(pitch) != -1) pitch--;
                                            intervalIter++;
                                        }
                                    } else {
                                        const pitchIndex: number = validateRange(0, recentPitches.length - 1, bits.read(recentPitchBitLength));
                                        pitch = recentPitches[pitchIndex];
                                        recentPitches.splice(pitchIndex, 1);
                                    }

                                    recentPitches.unshift(pitch);
                                    if (recentPitches.length > recentPitchLength) recentPitches.pop();

                                    if (j < shape.pitchCount) {
                                        note.pitches[pitchCount++] = pitch;
                                    } else {
                                        pitchBends.push(pitch);
                                    }

                                    if (j == shape.pitchCount - 1) {
                                        lastPitch = note.pitches[0];
                                    } else {
                                        lastPitch = pitch;
                                    }
                                }
                                note.pitches.length = pitchCount;
                                pitchBends.unshift(note.pitches[0]); // TODO: Use Deque?
                                const noteIsForTempoMod: boolean = isModChannel && channel.instruments[newPattern.instruments[0]].modulators[Config.modCount - 1 - note.pitches[0]] === Config.modulators.dictionary["tempo"].index;
                                let tempoOffset: number = 0;
                                if (shouldCorrectTempoMods && noteIsForTempoMod) {
                                    tempoOffset = jummboxTempoMin - Config.tempoMin; // convertRealFactor will add back Config.tempoMin as necessary
                                }
                                if (isModChannel) {
                                    note.pins[0].size += tempoOffset;
                                    note.pins[0].size *= detuneScaleNotes[newPattern.instruments[0]][note.pitches[0]];
                                }
                                let pinCount: number = 1;
                                for (const pinObj of shape.pins) {
                                    if (pinObj.pitchBend) pitchBends.shift();

                                    const interval: number = pitchBends[0] - note.pitches[0];
                                    if (note.pins.length <= pinCount) {
                                        if (isModChannel) {
                                            note.pins[pinCount++] = makeNotePin(interval, pinObj.time, pinObj.size * detuneScaleNotes[newPattern.instruments[0]][note.pitches[0]] + tempoOffset);
                                        } else {
                                            note.pins[pinCount++] = makeNotePin(interval, pinObj.time, pinObj.size);
                                        }
                                    } else {
                                        const pin: NotePin = note.pins[pinCount++];
                                        pin.interval = interval;
                                        pin.time = pinObj.time;
                                        if (isModChannel) {
                                            pin.size = pinObj.size * detuneScaleNotes[newPattern.instruments[0]][note.pitches[0]] + tempoOffset;
                                        } else {
                                            pin.size = pinObj.size;
                                        }
                                    }
                                }
                                note.pins.length = pinCount;

                                if (note.start == 0) {
                                    if (!((beforeNine && fromBeepBox) || (beforeFive && fromJummBox) || (beforeFour && fromGoldBox))) {
                                        note.continuesLastPattern = (bits.read(1) == 1);
                                    } else {
                                        if ((beforeFour && !fromUltraBox && !fromSlarmoosBox && !fromJukeBox) || fromBeepBox) {
                                            note.continuesLastPattern = false;
                                        } else {
                                            note.continuesLastPattern = channel.instruments[newPattern.instruments[0]].legacyTieOver;
                                        }
                                    }
                                }

                                curPart = validateRange(0, this.beatsPerBar * Config.partsPerBeat, note.end);
                            }
                        }
                        newNotes.length = noteCount;
                    }

                    if (beforeThree && fromBeepBox) {
                        break;
                    } else {
                        channelIndex++;
                        if (channelIndex >= this.getChannelCount()) break;
                    }
                } // while (true)

                // Correction for old JB songs that had song reverb mods. Change all instruments using reverb to max reverb
                if (((fromJummBox && beforeFive) || (beforeFour && fromGoldBox)) && songReverbIndex >= 0) {
                    for (let channelIndex: number = 0; channelIndex < this.channels.length; channelIndex++) {
                        for (let instrumentIndex: number = 0; instrumentIndex < this.channels[channelIndex].instruments.length; instrumentIndex++) {
                            const instrument: Instrument = this.channels[channelIndex].instruments[instrumentIndex];
                            if (effectsIncludeReverb(instrument.effects)) {
                                instrument.reverb = Config.reverbRange - 1;
                            }
                            // Set song reverb via mod to the old setting at song start.
                            if (songReverbChannel == channelIndex && songReverbInstrument == instrumentIndex) {
                                const patternIndex: number = this.channels[channelIndex].bars[0];
                                if (patternIndex > 0) {
                                    // Doesn't work if 1st pattern isn't using the right ins for song reverb...
                                    // Add note to start of pattern
                                    const pattern: Pattern = this.channels[channelIndex].patterns[patternIndex - 1];
                                    let lowestPart: number = 6;
                                    for (const note of pattern.notes) {
                                        if (note.pitches[0] == Config.modCount - 1 - songReverbIndex) {
                                            lowestPart = Math.min(lowestPart, note.start);
                                        }
                                    }

                                    if (lowestPart > 0) {
                                        pattern.notes.push(new Note(Config.modCount - 1 - songReverbIndex, 0, lowestPart, legacyGlobalReverb));
                                    }
                                }
                                else {
                                    // Add pattern
                                    if (this.channels[channelIndex].patterns.length < Config.barCountMax) {
                                        const pattern: Pattern = new Pattern();
                                        this.channels[channelIndex].patterns.push(pattern);
                                        this.channels[channelIndex].bars[0] = this.channels[channelIndex].patterns.length;
                                        if (this.channels[channelIndex].patterns.length > this.patternsPerChannel) {
                                            for (let chn: number = 0; chn < this.channels.length; chn++) {
                                                if (this.channels[chn].patterns.length <= this.patternsPerChannel) {
                                                    this.channels[chn].patterns.push(new Pattern());
                                                }
                                            }
                                            this.patternsPerChannel++;
                                        }
                                        pattern.instruments.length = 1;
                                        pattern.instruments[0] = songReverbInstrument;
                                        pattern.notes.length = 0;
                                        pattern.notes.push(new Note(Config.modCount - 1 - songReverbIndex, 0, 6, legacyGlobalReverb));
                                    }
                                }
                            }
                        }
                    }
                }
            } break;
            default: {
                throw new Error("Unrecognized song tag code " + String.fromCharCode(command) + " at index " + (charIndex - 1) + " " + compressed.substring(/*charIndex - 2*/0, charIndex));
            } break;
        }

        if (Config.willReloadForCustomSamples) {
            window.location.hash = this.toBase64String();
            setTimeout(() => { location.reload(); }, 50);
        }
    }

    private static _isProperUrl(string: string): boolean {
        try {
            if (OFFLINE) {
                return Boolean(string);
            } else {
                return Boolean(new URL(Song._normalizeUrl(string)));
            }
        }
        catch (x) {
            return false;
        }
    }

    // BreakBox: FileGarden and other hosts often hand out links without a
    // scheme (e.g. "file.garden/abc/break.mp3"). `new URL` rejects those as
    // relative paths, so prepend https:// when no scheme is present.
    private static _normalizeUrl(string: string): string {
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(string)) {
            return string; // already has a scheme (http:, https:, file:, data:, ...)
        }
        return "https://" + string;
    }

    // @TODO: Share more of this code with AddSamplesPrompt.
    private static _parseAndConfigureCustomSample(url: string, customSampleUrls: string[], customSamplePresets: Preset[], sampleLoadingState: SampleLoadingState, parseOldSyntax: boolean): boolean {
        const defaultIndex: number = 0;
        const defaultIntegratedSamples: Float32Array = Config.chipWaves[defaultIndex].samples;
        const defaultSamples: Float32Array = Config.rawRawChipWaves[defaultIndex].samples;

        const customSampleUrlIndex: number = customSampleUrls.length;
        customSampleUrls.push(url);
        // This depends on `Config.chipWaves` being the same
        // length as `Config.rawRawChipWaves`.
        const chipWaveIndex: number = Config.chipWaves.length;

        let urlSliced: string = url;

        let customSampleRate: number = 44100;
        let isCustomPercussive: boolean = false;
        let customRootKey: number = 60;
        let presetIsUsingAdvancedLoopControls: boolean = false;
        let presetChipWaveLoopStart: number | null = null;
        let presetChipWaveLoopEnd: number | null = null;
        let presetChipWaveStartOffset: number | null = null;
        let presetChipWaveLoopMode: number | null = null;
        let presetChipWavePlayBackwards: boolean = false;

        let parsedSampleOptions: boolean = false;
        let optionsStartIndex: number = url.indexOf("!");
        let optionsEndIndex: number = -1;
        if (optionsStartIndex === 0) {
            optionsEndIndex = url.indexOf("!", optionsStartIndex + 1);
            if (optionsEndIndex !== -1) {
                const rawOptions: string[] = url.slice(optionsStartIndex + 1, optionsEndIndex).split(",");
                for (const rawOption of rawOptions) {
                    const optionCode: string = rawOption.charAt(0);
                    const optionData: string = rawOption.slice(1, rawOption.length);
                    if (optionCode === "s") {
                        customSampleRate = clamp(8000, 96000 + 1, parseFloatWithDefault(optionData, 44100));
                    } else if (optionCode === "r") {
                        customRootKey = parseFloatWithDefault(optionData, 60);
                    } else if (optionCode === "p") {
                        isCustomPercussive = true;
                    } else if (optionCode === "a") {
                        presetChipWaveLoopStart = parseIntWithDefault(optionData, null);
                        if (presetChipWaveLoopStart != null) {
                            presetIsUsingAdvancedLoopControls = true;
                        }
                    } else if (optionCode === "b") {
                        presetChipWaveLoopEnd = parseIntWithDefault(optionData, null);
                        if (presetChipWaveLoopEnd != null) {
                            presetIsUsingAdvancedLoopControls = true;
                        }
                    } else if (optionCode === "c") {
                        presetChipWaveStartOffset = parseIntWithDefault(optionData, null);
                        if (presetChipWaveStartOffset != null) {
                            presetIsUsingAdvancedLoopControls = true;
                        }
                    } else if (optionCode === "d") {
                        presetChipWaveLoopMode = parseIntWithDefault(optionData, null);
                        if (presetChipWaveLoopMode != null) {
                            // @TODO: Error-prone. This should be automatically
                            // derived from the list of available loop modes.
                            presetChipWaveLoopMode = clamp(0, 3 + 1, presetChipWaveLoopMode);
                            presetIsUsingAdvancedLoopControls = true;
                        }
                    } else if (optionCode === "e") {
                        presetChipWavePlayBackwards = true;
                        presetIsUsingAdvancedLoopControls = true;
                    }
                }
                urlSliced = url.slice(optionsEndIndex + 1, url.length);
                parsedSampleOptions = true;
            }
        }

        let parsedUrl: URL | string | null = null;
        if (Song._isProperUrl(urlSliced)) {
            if (OFFLINE) {
                parsedUrl = urlSliced;
            } else {
                parsedUrl = new URL(Song._normalizeUrl(urlSliced));
            }
        }
        else {
            alert(url + " is not a valid url");
            return false;
        }

        if (parseOldSyntax) {
            if (!parsedSampleOptions && parsedUrl != null) {
                if (url.indexOf("@") != -1) {
                    //urlSliced = url.slice(url.indexOf("@"), url.indexOf("@"));
                    urlSliced = url.replaceAll("@", "")
                    if (OFFLINE) {
                        parsedUrl = urlSliced;
                    } else {
                        parsedUrl = new URL(Song._normalizeUrl(urlSliced));
                    }
                    isCustomPercussive = true;
                }

                function sliceForSampleRate() {
                    urlSliced = url.slice(0, url.indexOf(","));
                    if (OFFLINE) {
                        parsedUrl = urlSliced;
                    } else {
                        parsedUrl = new URL(Song._normalizeUrl(urlSliced));
                    }
                    customSampleRate = clamp(8000, 96000 + 1, parseFloatWithDefault(url.slice(url.indexOf(",") + 1), 44100));
                    //should this be parseFloat or parseInt?
                    //ig floats let you do decimals and such, but idk where that would be useful
                }

                function sliceForRootKey() {
                    urlSliced = url.slice(0, url.indexOf("!"));
                    if (OFFLINE) {
                        parsedUrl = urlSliced;
                    } else {
                        parsedUrl = new URL(Song._normalizeUrl(urlSliced));
                    }
                    customRootKey = parseFloatWithDefault(url.slice(url.indexOf("!") + 1), 60);
                }


                if (url.indexOf(",") != -1 && url.indexOf("!") != -1) {
                    if (url.indexOf(",") < url.indexOf("!")) {
                        sliceForRootKey();
                        sliceForSampleRate();
                    }
                    else {
                        sliceForSampleRate();
                        sliceForRootKey();
                    }
                }
                else {
                    if (url.indexOf(",") != -1) {
                        sliceForSampleRate();
                    }
                    if (url.indexOf("!") != -1) {
                        sliceForRootKey();
                    }
                }
            }
        }

        if (parsedUrl != null) {
            // BreakBox: normalize protocol-less URLs (e.g. FileGarden's
            // "file.garden/abc/break.mp3") before storing for fetch().
            // Skip in OFFLINE mode, which may use relative or file: paths.
            if (!OFFLINE) {
                urlSliced = Song._normalizeUrl(urlSliced);
            }
            // Store in the new format.
            let urlWithNamedOptions = urlSliced;
            const namedOptions: string[] = [];
            if (customSampleRate !== 44100) namedOptions.push("s" + customSampleRate);
            if (customRootKey !== 60) namedOptions.push("r" + customRootKey);
            if (isCustomPercussive) namedOptions.push("p");
            if (presetIsUsingAdvancedLoopControls) {
                if (presetChipWaveLoopStart != null) namedOptions.push("a" + presetChipWaveLoopStart);
                if (presetChipWaveLoopEnd != null) namedOptions.push("b" + presetChipWaveLoopEnd);
                if (presetChipWaveStartOffset != null) namedOptions.push("c" + presetChipWaveStartOffset);
                if (presetChipWaveLoopMode != null) namedOptions.push("d" + presetChipWaveLoopMode);
                if (presetChipWavePlayBackwards) namedOptions.push("e");
            }
            if (namedOptions.length > 0) {
                urlWithNamedOptions = "!" + namedOptions.join(",") + "!" + urlSliced;
            }
            customSampleUrls[customSampleUrlIndex] = urlWithNamedOptions;

            // @TODO: Could also remove known extensions, but it
            // would probably be much better to be able to specify
            // a custom name.
            // @TODO: If for whatever inexplicable reason someone
            // uses an url like `https://example.com`, this will
            // result in an empty name here.
            let name: string;
            if (OFFLINE) {
                //@ts-ignore
                name = decodeURIComponent(parsedUrl.replace(/^([^\/]*\/)+/, ""));
            } else {
                //@ts-ignore
                name = decodeURIComponent(parsedUrl.pathname.replace(/^([^\/]*\/)+/, ""));
            }
            // @TODO: What to do about samples with the same name?
            // The problem with using the url is that the name is
            // user-facing and long names break assumptions of the
            // UI.
            const expression: number = 1.0;
            Config.chipWaves[chipWaveIndex] = {
                name: name,
                expression: expression,
                isCustomSampled: true,
                isPercussion: isCustomPercussive,
                rootKey: customRootKey,
                sampleRate: customSampleRate,
                samples: defaultIntegratedSamples,
                index: chipWaveIndex,
            };
            Config.rawChipWaves[chipWaveIndex] = {
                name: name,
                expression: expression,
                isCustomSampled: true,
                isPercussion: isCustomPercussive,
                rootKey: customRootKey,
                sampleRate: customSampleRate,
                samples: defaultSamples,
                index: chipWaveIndex,
            };
            Config.rawRawChipWaves[chipWaveIndex] = {
                name: name,
                expression: expression,
                isCustomSampled: true,
                isPercussion: isCustomPercussive,
                rootKey: customRootKey,
                sampleRate: customSampleRate,
                samples: defaultSamples,
                index: chipWaveIndex,
            };
            const customSamplePresetSettings: Dictionary<any> = {
                "type": "chip",
                "eqFilter": [],
                "effects": [],
                "transition": "normal",
                "fadeInSeconds": 0,
                "fadeOutTicks": -3,
                "chord": "harmony",
                "wave": name,
                "unison": "none",
                "envelopes": [],
            };
            if (presetIsUsingAdvancedLoopControls) {
                customSamplePresetSettings["isUsingAdvancedLoopControls"] = true;
                customSamplePresetSettings["chipWaveLoopStart"] = presetChipWaveLoopStart != null ? presetChipWaveLoopStart : 0;
                customSamplePresetSettings["chipWaveLoopEnd"] = presetChipWaveLoopEnd != null ? presetChipWaveLoopEnd : 2;
                customSamplePresetSettings["chipWaveLoopMode"] = presetChipWaveLoopMode != null ? presetChipWaveLoopMode : 0;
                customSamplePresetSettings["chipWavePlayBackwards"] = presetChipWavePlayBackwards;
                customSamplePresetSettings["chipWaveStartOffset"] = presetChipWaveStartOffset != null ? presetChipWaveStartOffset : 0;
            }
            const customSamplePreset: Preset = {
                index: 0, // This should be overwritten by toNameMap, in our caller.
                name: name,
                midiProgram: 80,
                settings: customSamplePresetSettings,
            };
            customSamplePresets.push(customSamplePreset);
            if (!Config.willReloadForCustomSamples) {
                const rawLoopOptions: any = {
                    "isUsingAdvancedLoopControls": presetIsUsingAdvancedLoopControls,
                    "chipWaveLoopStart": presetChipWaveLoopStart,
                    "chipWaveLoopEnd": presetChipWaveLoopEnd,
                    "chipWaveLoopMode": presetChipWaveLoopMode,
                    "chipWavePlayBackwards": presetChipWavePlayBackwards,
                    "chipWaveStartOffset": presetChipWaveStartOffset,
                };
                startLoadingSample(urlSliced, chipWaveIndex, customSamplePresetSettings, rawLoopOptions, customSampleRate);
            }
            sampleLoadingState.statusTable[chipWaveIndex] = SampleLoadingStatus.loading;
            sampleLoadingState.urlTable[chipWaveIndex] = urlSliced;
            sampleLoadingState.totalSamples++;
        }

        return true;
    }

    private static _restoreChipWaveListToDefault(): void {
        Config.chipWaves = toNameMap(Config.chipWaves.slice(0, Config.firstIndexForSamplesInChipWaveList));
        Config.rawChipWaves = toNameMap(Config.rawChipWaves.slice(0, Config.firstIndexForSamplesInChipWaveList));
        Config.rawRawChipWaves = toNameMap(Config.rawRawChipWaves.slice(0, Config.firstIndexForSamplesInChipWaveList));
    }

    private static _clearSamples(): void {
        EditorConfig.customSamples = null;

        Song._restoreChipWaveListToDefault();

        sampleLoadingState.statusTable = {};
        sampleLoadingState.urlTable = {};
        sampleLoadingState.totalSamples = 0;
        sampleLoadingState.samplesLoaded = 0;
        sampleLoadEvents.dispatchEvent(new SampleLoadedEvent(
            sampleLoadingState.totalSamples,
            sampleLoadingState.samplesLoaded
        ));
    }

    public toJsonObject(enableIntro: boolean = true, loopCount: number = 1, enableOutro: boolean = true): Object {
        const channelArray: Object[] = [];
        for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
            const channel: Channel = this.channels[channelIndex];
            const instrumentArray: Object[] = [];
            const isNoiseChannel: boolean = this.getChannelIsNoise(channelIndex);
            const isModChannel: boolean = this.getChannelIsMod(channelIndex);
            for (const instrument of channel.instruments) {
                instrumentArray.push(instrument.toJsonObject());
            }

            const patternArray: Object[] = [];
            for (const pattern of channel.patterns) {
                patternArray.push(pattern.toJsonObject(this, channel, isModChannel));
            }

            const sequenceArray: number[] = [];
            if (enableIntro) for (let i: number = 0; i < this.loopStart; i++) {
                sequenceArray.push(channel.bars[i]);
            }
            for (let l: number = 0; l < loopCount; l++) for (let i: number = this.loopStart; i < this.loopStart + this.loopLength; i++) {
                sequenceArray.push(channel.bars[i]);
            }
            if (enableOutro) for (let i: number = this.loopStart + this.loopLength; i < this.barCount; i++) {
                sequenceArray.push(channel.bars[i]);
            }

            const channelObject: any = {
                "type": isModChannel ? "mod" : (isNoiseChannel ? "drum" : "pitch"),
                "name": channel.name,
                "instruments": instrumentArray,
                "patterns": patternArray,
                "sequence": sequenceArray,
            };
            if (!isNoiseChannel) {
                // For compatibility with old versions the octave is offset by one.
                channelObject["octaveScrollBar"] = channel.octave - 1;
            }
            channelArray.push(channelObject);
        }

        const result: any = {
            "name": this.title,
            "format": Song._format,
            "version": Song._latestJukeBoxVersion,
            "scale": Config.scales[this.scale].name,
            "customScale": this.scaleCustom,
            "key": Config.keys[this.key].name,
            "keyOctave": this.octave,
            "introBars": this.loopStart,
            "loopBars": this.loopLength,
            "beatsPerBar": this.beatsPerBar,
            "ticksPerBeat": Config.rhythms[this.rhythm].stepsPerBeat,
            "beatsPerMinute": this.tempo,
            "reverb": this.reverb,
            "masterGain": this.masterGain,
            "compressionThreshold": this.compressionThreshold,
            "limitThreshold": this.limitThreshold,
            "limitDecay": this.limitDecay,
            "limitRise": this.limitRise,
            "limitRatio": this.limitRatio,
            "compressionRatio": this.compressionRatio,
            //"outroBars": this.barCount - this.loopStart - this.loopLength; // derive this from bar arrays?
            //"patternCount": this.patternsPerChannel, // derive this from pattern arrays?
            "songEq": this.eqFilter.toJsonObject(),
            "layeredInstruments": this.layeredInstruments,
            "patternInstruments": this.patternInstruments,
            "channels": channelArray,
        };

        //song eq subfilters
        for (let i: number = 0; i < Config.filterMorphCount - 1; i++) {
            result["songEq" + i] = this.eqSubFilters[i];
        }

        if (EditorConfig.customSamples != null && EditorConfig.customSamples.length > 0) {
            result["customSamples"] = EditorConfig.customSamples;
        }

        return result;
    }

    public fromJsonObject(jsonObject: any, jsonFormat: string = "auto"): void {
        this.initToDefault(true);
        if (!jsonObject) return;

        //const version: number = jsonObject["version"] | 0;
        //if (version > Song._latestVersion) return; // Go ahead and try to parse something from the future I guess? JSON is pretty easy-going!

        // Code for auto-detect mode; if statements that are lower down have 'higher priority'
        if (jsonFormat == "auto") {
            if (jsonObject["format"] == "BeepBox") {
                // Assume that if there is a "riff" song setting then it must be modbox
                if (jsonObject["riff"] != undefined) {
                    jsonFormat = "modbox";
                }

                // Assume that if there are limiter song settings then it must be jummbox
                // Despite being added in JB 2.1, json export for the limiter settings wasn't added until 2.3
                if (jsonObject["masterGain"] != undefined) {
                    jsonFormat = "jummbox";
                }
            }
        }

        const format: string = (jsonFormat == "auto" ? jsonObject["format"] : jsonFormat).toLowerCase();

        if (jsonObject["name"] != undefined) {
            this.title = jsonObject["name"];
        }

        if (jsonObject["customSamples"] != undefined) {
            const customSamples: string[] = jsonObject["customSamples"];
            if (EditorConfig.customSamples == null || EditorConfig.customSamples.join(", ") != customSamples.join(", ")) {
                // Have to duplicate the work done in Song.fromBase64String
                // early here, because Instrument.fromJsonObject depends on the
                // chip wave list having the correct items already in memory.

                Config.willReloadForCustomSamples = true;

                Song._restoreChipWaveListToDefault();

                let willLoadLegacySamples: boolean = false;
                let willLoadNintariboxSamples: boolean = false;
                let willLoadMarioPaintboxSamples: boolean = false;
                const customSampleUrls: string[] = [];
                const customSamplePresets: Preset[] = [];
                for (const url of customSamples) {
                    if (url.toLowerCase() === "legacysamples") {
                        if (!willLoadLegacySamples) {
                            willLoadLegacySamples = true;
                            customSampleUrls.push(url);
                            loadBuiltInSamples(0);
                        }
                    }
                    else if (url.toLowerCase() === "nintariboxsamples") {
                        if (!willLoadNintariboxSamples) {
                            willLoadNintariboxSamples = true;
                            customSampleUrls.push(url);
                            loadBuiltInSamples(1);
                        }
                    }
                    else if (url.toLowerCase() === "mariopaintboxsamples") {
                        if (!willLoadMarioPaintboxSamples) {
                            willLoadMarioPaintboxSamples = true;
                            customSampleUrls.push(url);
                            loadBuiltInSamples(2);
                        }
                    }

                    else {
                        // When EditorConfig.customSamples is saved in the json
                        // export, it should be using the new syntax, unless
                        // the user has manually modified the URL, so we don't
                        // really need to parse the old syntax here.
                        const parseOldSyntax: boolean = false;
                        Song._parseAndConfigureCustomSample(url, customSampleUrls, customSamplePresets, sampleLoadingState, parseOldSyntax);
                    }
                }
                if (customSampleUrls.length > 0) {
                    EditorConfig.customSamples = customSampleUrls;
                }
                if (customSamplePresets.length > 0) {
                    const customSamplePresetsMap: DictionaryArray<Preset> = toNameMap(customSamplePresets);
                    EditorConfig.presetCategories[EditorConfig.presetCategories.length] = {
                        name: "Custom Sample Presets",
                        presets: customSamplePresetsMap,
                        index: EditorConfig.presetCategories.length,
                    };
                }
            }
        } else {
            // No custom samples, so the only possibility at this point is that
            // we need to load the legacy samples. Let's check whether that's
            // necessary.
            let shouldLoadLegacySamples: boolean = false;
            if (jsonObject["channels"] != undefined) {
                for (let channelIndex: number = 0; channelIndex < jsonObject["channels"].length; channelIndex++) {
                    const channelObject: any = jsonObject["channels"][channelIndex];
                    if (channelObject["type"] !== "pitch") {
                        // Legacy samples can only exist in pitch channels.
                        continue;
                    }
                    if (Array.isArray(channelObject["instruments"])) {
                        const instrumentObjects: any[] = channelObject["instruments"];
                        for (let i: number = 0; i < instrumentObjects.length; i++) {
                            const instrumentObject: any = instrumentObjects[i];
                            if (instrumentObject["type"] !== "chip") {
                                // Legacy samples can only exist in chip wave
                                // instruments.
                                continue;
                            }
                            if (instrumentObject["wave"] == null) {
                                // This should exist if things got saved
                                // correctly, but if they didn't, skip this.
                                continue;
                            }
                            const waveName: string = instrumentObject["wave"];
                            // @TODO: Avoid this duplication.
                            const names: string[] = [
                                "paandorasbox kick",
                                "paandorasbox snare",
                                "paandorasbox piano1",
                                "paandorasbox WOW",
                                "paandorasbox overdrive",
                                "paandorasbox trumpet",
                                "paandorasbox saxophone",
                                "paandorasbox orchestrahit",
                                "paandorasbox detatched violin",
                                "paandorasbox synth",
                                "paandorasbox sonic3snare",
                                "paandorasbox come on",
                                "paandorasbox choir",
                                "paandorasbox overdriveguitar",
                                "paandorasbox flute",
                                "paandorasbox legato violin",
                                "paandorasbox tremolo violin",
                                "paandorasbox amen break",
                                "paandorasbox pizzicato violin",
                                "paandorasbox tim allen grunt",
                                "paandorasbox tuba",
                                "paandorasbox loopingcymbal",
                                "paandorasbox standardkick",
                                "paandorasbox standardsnare",
                                "paandorasbox closedhihat",
                                "paandorasbox foothihat",
                                "paandorasbox openhihat",
                                "paandorasbox crashcymbal",
                                "paandorasbox pianoC4",
                                "paandorasbox liver pad",
                                "paandorasbox marimba",
                                "paandorasbox susdotwav",
                                "paandorasbox wackyboxtts",
                                "paandorasbox peppersteak_1",
                                "paandorasbox peppersteak_2",
                                "paandorasbox vinyl_noise",
                                "paandorasbeta slap bass",
                                "paandorasbeta HD EB overdrive guitar",
                                "paandorasbeta sunsoft bass",
                                "paandorasbeta masculine choir",
                                "paandorasbeta feminine choir",
                                "paandorasbeta tololoche",
                                "paandorasbeta harp",
                                "paandorasbeta pan flute",
                                "paandorasbeta krumhorn",
                                "paandorasbeta timpani",
                                "paandorasbeta crowd hey",
                                "paandorasbeta wario land 4 brass",
                                "paandorasbeta wario land 4 rock organ",
                                "paandorasbeta wario land 4 DAOW",
                                "paandorasbeta wario land 4 hour chime",
                                "paandorasbeta wario land 4 tick",
                                "paandorasbeta kirby kick",
                                "paandorasbeta kirby snare",
                                "paandorasbeta kirby bongo",
                                "paandorasbeta kirby click",
                                "paandorasbeta sonor kick",
                                "paandorasbeta sonor snare",
                                "paandorasbeta sonor snare (left hand)",
                                "paandorasbeta sonor snare (right hand)",
                                "paandorasbeta sonor high tom",
                                "paandorasbeta sonor low tom",
                                "paandorasbeta sonor hihat (closed)",
                                "paandorasbeta sonor hihat (half opened)",
                                "paandorasbeta sonor hihat (open)",
                                "paandorasbeta sonor hihat (open tip)",
                                "paandorasbeta sonor hihat (pedal)",
                                "paandorasbeta sonor crash",
                                "paandorasbeta sonor crash (tip)",
                                "paandorasbeta sonor ride"
                            ];
                            // The difference for these is in the doubled a.
                            const oldNames: string[] = [
                                "pandoraasbox kick",
                                "pandoraasbox snare",
                                "pandoraasbox piano1",
                                "pandoraasbox WOW",
                                "pandoraasbox overdrive",
                                "pandoraasbox trumpet",
                                "pandoraasbox saxophone",
                                "pandoraasbox orchestrahit",
                                "pandoraasbox detatched violin",
                                "pandoraasbox synth",
                                "pandoraasbox sonic3snare",
                                "pandoraasbox come on",
                                "pandoraasbox choir",
                                "pandoraasbox overdriveguitar",
                                "pandoraasbox flute",
                                "pandoraasbox legato violin",
                                "pandoraasbox tremolo violin",
                                "pandoraasbox amen break",
                                "pandoraasbox pizzicato violin",
                                "pandoraasbox tim allen grunt",
                                "pandoraasbox tuba",
                                "pandoraasbox loopingcymbal",
                                "pandoraasbox standardkick",
                                "pandoraasbox standardsnare",
                                "pandoraasbox closedhihat",
                                "pandoraasbox foothihat",
                                "pandoraasbox openhihat",
                                "pandoraasbox crashcymbal",
                                "pandoraasbox pianoC4",
                                "pandoraasbox liver pad",
                                "pandoraasbox marimba",
                                "pandoraasbox susdotwav",
                                "pandoraasbox wackyboxtts",
                                "pandoraasbox peppersteak_1",
                                "pandoraasbox peppersteak_2",
                                "pandoraasbox vinyl_noise",
                                "pandoraasbeta slap bass",
                                "pandoraasbeta HD EB overdrive guitar",
                                "pandoraasbeta sunsoft bass",
                                "pandoraasbeta masculine choir",
                                "pandoraasbeta feminine choir",
                                "pandoraasbeta tololoche",
                                "pandoraasbeta harp",
                                "pandoraasbeta pan flute",
                                "pandoraasbeta krumhorn",
                                "pandoraasbeta timpani",
                                "pandoraasbeta crowd hey",
                                "pandoraasbeta wario land 4 brass",
                                "pandoraasbeta wario land 4 rock organ",
                                "pandoraasbeta wario land 4 DAOW",
                                "pandoraasbeta wario land 4 hour chime",
                                "pandoraasbeta wario land 4 tick",
                                "pandoraasbeta kirby kick",
                                "pandoraasbeta kirby snare",
                                "pandoraasbeta kirby bongo",
                                "pandoraasbeta kirby click",
                                "pandoraasbeta sonor kick",
                                "pandoraasbeta sonor snare",
                                "pandoraasbeta sonor snare (left hand)",
                                "pandoraasbeta sonor snare (right hand)",
                                "pandoraasbeta sonor high tom",
                                "pandoraasbeta sonor low tom",
                                "pandoraasbeta sonor hihat (closed)",
                                "pandoraasbeta sonor hihat (half opened)",
                                "pandoraasbeta sonor hihat (open)",
                                "pandoraasbeta sonor hihat (open tip)",
                                "pandoraasbeta sonor hihat (pedal)",
                                "pandoraasbeta sonor crash",
                                "pandoraasbeta sonor crash (tip)",
                                "pandoraasbeta sonor ride"
                            ];
                            // This mirrors paandorasboxWaveNames, which is unprefixed.
                            const veryOldNames: string[] = [
                                "kick",
                                "snare",
                                "piano1",
                                "WOW",
                                "overdrive",
                                "trumpet",
                                "saxophone",
                                "orchestrahit",
                                "detatched violin",
                                "synth",
                                "sonic3snare",
                                "come on",
                                "choir",
                                "overdriveguitar",
                                "flute",
                                "legato violin",
                                "tremolo violin",
                                "amen break",
                                "pizzicato violin",
                                "tim allen grunt",
                                "tuba",
                                "loopingcymbal",
                                "standardkick",
                                "standardsnare",
                                "closedhihat",
                                "foothihat",
                                "openhihat",
                                "crashcymbal",
                                "pianoC4",
                                "liver pad",
                                "marimba",
                                "susdotwav",
                                "wackyboxtts"
                            ];
                            if (names.includes(waveName)) {
                                shouldLoadLegacySamples = true;
                            } else if (oldNames.includes(waveName)) {
                                shouldLoadLegacySamples = true;
                                // If we see one of these old names, update it
                                // to the corresponding new name.
                                instrumentObject["wave"] = names[oldNames.findIndex(x => x === waveName)];
                            } else if (veryOldNames.includes(waveName)) {
                                if ((waveName === "trumpet" || waveName === "flute") && (format != "paandorasbox")) {
                                    // If we see chip waves named trumpet or flute, and if the format isn't PaandorasBox, we leave them as-is
                                } else {
                                    // There's no other chip waves with ambiguous names like that, so it should
                                    // be okay to assume we'll need to load the legacy samples now.
                                    shouldLoadLegacySamples = true;
                                    // If we see one of these old names, update it
                                    // to the corresponding new name.
                                    instrumentObject["wave"] = names[veryOldNames.findIndex(x => x === waveName)];
                                }
                            }
                        }
                    }
                }
            }
            if (shouldLoadLegacySamples) {
                Config.willReloadForCustomSamples = true;

                Song._restoreChipWaveListToDefault();

                loadBuiltInSamples(0);
                EditorConfig.customSamples = ["legacySamples"];
            } else {
                // We don't need to load the legacy samples, but we may have
                // leftover samples in memory. If we do, clear them.
                if (EditorConfig.customSamples != null && EditorConfig.customSamples.length > 0) {
                    // We need to reload anyway in this case, because (for now)
                    // the chip wave lists won't be correctly updated.
                    Config.willReloadForCustomSamples = true;
                    Song._clearSamples();
                }
            }
        }

        this.scale = 0; // default to free.
        if (jsonObject["scale"] != undefined) {
            const oldScaleNames: Dictionary<string> = {
                "romani :)": "double harmonic :)",
                "romani :(": "double harmonic :(",
                "dbl harmonic :)": "double harmonic :)",
                "dbl harmonic :(": "double harmonic :(",
                "enigma": "strange",
            };
            const scaleName: string = (oldScaleNames[jsonObject["scale"]] != undefined) ? oldScaleNames[jsonObject["scale"]] : jsonObject["scale"];
            const scale: number = Config.scales.findIndex(scale => scale.name == scaleName);
            if (scale != -1) this.scale = scale;
            if (this.scale == Config.scales["dictionary"]["Custom"].index) {
                if (jsonObject["customScale"] != undefined) {
                    for (var i of jsonObject["customScale"].keys()) {
                        this.scaleCustom[i] = jsonObject["customScale"][i];
                    }
                }
            }
        }

        if (jsonObject["key"] != undefined) {
            if (typeof (jsonObject["key"]) == "number") {
                this.key = ((jsonObject["key"] + 1200) >>> 0) % Config.keys.length;
            } else if (typeof (jsonObject["key"]) == "string") {
                const key: string = jsonObject["key"];
                // This conversion code depends on C through B being
                // available as keys, of course.
                if (key === "C+") {
                    this.key = 0;
                    this.octave = 1;
                } else if (key === "G- (actually F#-)") {
                    this.key = 6;
                    this.octave = -1;
                } else if (key === "C-") {
                    this.key = 0;
                    this.octave = -1;
                } else if (key === "oh no (F-)") {
                    this.key = 5;
                    this.octave = -1;
                } else {
                    const letter: string = key.charAt(0).toUpperCase();
                    const symbol: string = key.charAt(1).toLowerCase();
                    const letterMap: Readonly<Dictionary<number>> = { "C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11 };
                    const accidentalMap: Readonly<Dictionary<number>> = { "#": 1, "♯": 1, "b": -1, "♭": -1 };
                    let index: number | undefined = letterMap[letter];
                    const offset: number | undefined = accidentalMap[symbol];
                    if (index != undefined) {
                        if (offset != undefined) index += offset;
                        if (index < 0) index += 12;
                        index = index % 12;
                        this.key = index;
                    }
                }
            }
        }

        if (jsonObject["beatsPerMinute"] != undefined) {
            this.tempo = clamp(Config.tempoMin, Config.tempoMax + 1, jsonObject["beatsPerMinute"] | 0);
        }

        if (jsonObject["keyOctave"] != undefined) {
            this.octave = clamp(Config.octaveMin, Config.octaveMax + 1, jsonObject["keyOctave"] | 0);
        }

        let legacyGlobalReverb: number = 0; // In older songs, reverb was song-global, record that here and pass it to Instrument.fromJsonObject() for context.
        if (jsonObject["reverb"] != undefined) {
            legacyGlobalReverb = clamp(0, 32, jsonObject["reverb"] | 0);
        }

        if (jsonObject["beatsPerBar"] != undefined) {
            this.beatsPerBar = Math.max(Config.beatsPerBarMin, Math.min(Config.beatsPerBarMax, jsonObject["beatsPerBar"] | 0));
        }

        let importedPartsPerBeat: number = 4;
        if (jsonObject["ticksPerBeat"] != undefined) {
            importedPartsPerBeat = (jsonObject["ticksPerBeat"] | 0) || 4;
            this.rhythm = Config.rhythms.findIndex(rhythm => rhythm.stepsPerBeat == importedPartsPerBeat);
            if (this.rhythm == -1) {
                this.rhythm = 1; //default rhythm
            }
        }

        // Read limiter settings. Ranges and defaults are based on slider settings

        if (jsonObject["masterGain"] != undefined) {
            this.masterGain = Math.max(0.0, Math.min(5.0, jsonObject["masterGain"] || 0));
        } else {
            this.masterGain = 1.0;
        }

        if (jsonObject["limitThreshold"] != undefined) {
            this.limitThreshold = Math.max(0.0, Math.min(2.0, jsonObject["limitThreshold"] || 0));
        } else {
            this.limitThreshold = 1.0;
        }

        if (jsonObject["compressionThreshold"] != undefined) {
            this.compressionThreshold = Math.max(0.0, Math.min(1.1, jsonObject["compressionThreshold"] || 0));
        } else {
            this.compressionThreshold = 1.0;
        }

        if (jsonObject["limitRise"] != undefined) {
            this.limitRise = Math.max(2000.0, Math.min(10000.0, jsonObject["limitRise"] || 0));
        } else {
            this.limitRise = 4000.0;
        }

        if (jsonObject["limitDecay"] != undefined) {
            this.limitDecay = Math.max(1.0, Math.min(30.0, jsonObject["limitDecay"] || 0));
        } else {
            this.limitDecay = 4.0;
        }

        if (jsonObject["limitRatio"] != undefined) {
            this.limitRatio = Math.max(0.0, Math.min(11.0, jsonObject["limitRatio"] || 0));
        } else {
            this.limitRatio = 1.0;
        }

        if (jsonObject["compressionRatio"] != undefined) {
            this.compressionRatio = Math.max(0.0, Math.min(1.168, jsonObject["compressionRatio"] || 0));
        } else {
            this.compressionRatio = 1.0;
        }

        if (jsonObject["songEq"] != undefined) {
            this.eqFilter.fromJsonObject(jsonObject["songEq"]);
        } else {
            this.eqFilter.reset();
        }

        for (let i: number = 0; i < Config.filterMorphCount - 1; i++) {
            if (jsonObject["songEq" + i]) {
                this.eqSubFilters[i] = jsonObject["songEq" + i];
            } else {
                this.eqSubFilters[i] = null;
            }
        }

        let maxInstruments: number = 1;
        let maxPatterns: number = 1;
        let maxBars: number = 1;
        if (jsonObject["channels"] != undefined) {
            for (const channelObject of jsonObject["channels"]) {
                if (channelObject["instruments"]) maxInstruments = Math.max(maxInstruments, channelObject["instruments"].length | 0);
                if (channelObject["patterns"]) maxPatterns = Math.max(maxPatterns, channelObject["patterns"].length | 0);
                if (channelObject["sequence"]) maxBars = Math.max(maxBars, channelObject["sequence"].length | 0);
            }
        }

        if (jsonObject["layeredInstruments"] != undefined) {
            this.layeredInstruments = !!jsonObject["layeredInstruments"];
        } else {
            this.layeredInstruments = false;
        }
        if (jsonObject["patternInstruments"] != undefined) {
            this.patternInstruments = !!jsonObject["patternInstruments"];
        } else {
            this.patternInstruments = (maxInstruments > 1);
        }
        this.patternsPerChannel = Math.min(maxPatterns, Config.barCountMax);
        this.barCount = Math.min(maxBars, Config.barCountMax);

        if (jsonObject["introBars"] != undefined) {
            this.loopStart = clamp(0, this.barCount, jsonObject["introBars"] | 0);
        }
        if (jsonObject["loopBars"] != undefined) {
            this.loopLength = clamp(1, this.barCount - this.loopStart + 1, jsonObject["loopBars"] | 0);
        }

        const newPitchChannels: Channel[] = [];
        const newNoiseChannels: Channel[] = [];
        const newModChannels: Channel[] = [];
        if (jsonObject["channels"] != undefined) {
            for (let channelIndex: number = 0; channelIndex < jsonObject["channels"].length; channelIndex++) {
                let channelObject: any = jsonObject["channels"][channelIndex];

                const channel: Channel = new Channel();

                let isNoiseChannel: boolean = false;
                let isModChannel: boolean = false;
                if (channelObject["type"] != undefined) {
                    isNoiseChannel = (channelObject["type"] == "drum");
                    isModChannel = (channelObject["type"] == "mod");
                } else {
                    // for older files, assume drums are channel 3.
                    isNoiseChannel = (channelIndex >= 3);
                }
                if (isNoiseChannel) {
                    newNoiseChannels.push(channel);
                } else if (isModChannel) {
                    newModChannels.push(channel);
                }
                else {
                    newPitchChannels.push(channel);
                }

                if (channelObject["octaveScrollBar"] != undefined) {
                    channel.octave = clamp(0, Config.pitchOctaves, (channelObject["octaveScrollBar"] | 0) + 1);
                    if (isNoiseChannel) channel.octave = 0;
                }

                if (channelObject["name"] != undefined) {
                    channel.name = channelObject["name"];
                }
                else {
                    channel.name = "";
                }

                if (Array.isArray(channelObject["instruments"])) {
                    const instrumentObjects: any[] = channelObject["instruments"];
                    for (let i: number = 0; i < instrumentObjects.length; i++) {
                        if (i >= this.getMaxInstrumentsPerChannel()) break;
                        const instrument: Instrument = new Instrument(isNoiseChannel, isModChannel);
                        channel.instruments[i] = instrument;
                        instrument.fromJsonObject(instrumentObjects[i], isNoiseChannel, isModChannel, false, false, legacyGlobalReverb, format);
                    }

                }

                for (let i: number = 0; i < this.patternsPerChannel; i++) {
                    const pattern: Pattern = new Pattern();
                    channel.patterns[i] = pattern;

                    let patternObject: any = undefined;
                    if (channelObject["patterns"]) patternObject = channelObject["patterns"][i];
                    if (patternObject == undefined) continue;

                    pattern.fromJsonObject(patternObject, this, channel, importedPartsPerBeat, isNoiseChannel, isModChannel, format);
                }
                channel.patterns.length = this.patternsPerChannel;

                for (let i: number = 0; i < this.barCount; i++) {
                    channel.bars[i] = (channelObject["sequence"] != undefined) ? Math.min(this.patternsPerChannel, channelObject["sequence"][i] >>> 0) : 0;
                }
                channel.bars.length = this.barCount;
            }
        }

        if (newPitchChannels.length > Config.pitchChannelCountMax) newPitchChannels.length = Config.pitchChannelCountMax;
        if (newNoiseChannels.length > Config.noiseChannelCountMax) newNoiseChannels.length = Config.noiseChannelCountMax;
        if (newModChannels.length > Config.modChannelCountMax) newModChannels.length = Config.modChannelCountMax;
        this.pitchChannelCount = newPitchChannels.length;
        this.noiseChannelCount = newNoiseChannels.length;
        this.modChannelCount = newModChannels.length;
        this.channels.length = 0;
        Array.prototype.push.apply(this.channels, newPitchChannels);
        Array.prototype.push.apply(this.channels, newNoiseChannels);
        Array.prototype.push.apply(this.channels, newModChannels);

        if (Config.willReloadForCustomSamples) {
            window.location.hash = this.toBase64String();
            // The prompt seems to get stuck if reloading is done too quickly.
            setTimeout(() => { location.reload(); }, 50);
        }
    }

    public getPattern(channelIndex: number, bar: number): Pattern | null {
        if (bar < 0 || bar >= this.barCount) return null;
        const patternIndex: number = this.channels[channelIndex].bars[bar];
        if (patternIndex == 0) return null;
        return this.channels[channelIndex].patterns[patternIndex - 1];
    }

    public getBeatsPerMinute(): number {
        return this.tempo;
    }

    public static getNeededBits(maxValue: number): number {
        return 32 - Math.clz32(Math.ceil(maxValue + 1) - 1);
    }

    public restoreLimiterDefaults(): void {
        this.compressionRatio = 1.0;
        this.limitRatio = 1.0;
        this.limitRise = 4000.0;
        this.limitDecay = 4.0;
        this.limitThreshold = 1.0;
        this.compressionThreshold = 1.0;
        this.masterGain = 1.0;
    }
}

