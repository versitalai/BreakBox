// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: util.ts (base64 tables); model.ts (serialization: CharCode, BitFieldReader/Writer)



export const enum CharCode {
    SPACE = 32,
    HASH = 35,
    PERCENT = 37,
    AMPERSAND = 38,
    PLUS = 43,
    DASH = 45,
    DOT = 46,
    NUM_0 = 48,
    NUM_1 = 49,
    NUM_2 = 50,
    NUM_3 = 51,
    NUM_4 = 52,
    NUM_5 = 53,
    NUM_6 = 54,
    NUM_7 = 55,
    NUM_8 = 56,
    NUM_9 = 57,
    EQUALS = 61,
    A = 65,
    B = 66,
    C = 67,
    D = 68,
    E = 69,
    F = 70,
    G = 71,
    H = 72,
    I = 73,
    J = 74,
    K = 75,
    L = 76,
    M = 77,
    N = 78,
    O = 79,
    P = 80,
    Q = 81,
    R = 82,
    S = 83,
    T = 84,
    U = 85,
    V = 86,
    W = 87,
    X = 88,
    Y = 89,
    Z = 90,
    UNDERSCORE = 95,
    a = 97,
    b = 98,
    c = 99,
    d = 100,
    e = 101,
    f = 102,
    g = 103,
    h = 104,
    i = 105,
    j = 106,
    k = 107,
    l = 108,
    m = 109,
    n = 110,
    o = 111,
    p = 112,
    q = 113,
    r = 114,
    s = 115,
    t = 116,
    u = 117,
    v = 118,
    w = 119,
    x = 120,
    y = 121,
    z = 122,
    LEFT_CURLY_BRACE = 123,
    RIGHT_CURLY_BRACE = 125,
}

export const enum SongTagCode {
    beatCount = CharCode.a, // added in BeepBox URL version 2
    bars = CharCode.b, // added in BeepBox URL version 2
    songEq = CharCode.c, // added in BeepBox URL version 2 for vibrato, switched to song eq in Slarmoo's Box 1.3
    fadeInOut = CharCode.d, // added in BeepBox URL version 3 for transition, switched to fadeInOut in 9
    loopEnd = CharCode.e, // added in BeepBox URL version 2
    eqFilter = CharCode.f, // added in BeepBox URL version 3
    barCount = CharCode.g, // added in BeepBox URL version 3
    unison = CharCode.h, // added in BeepBox URL version 2
    instrumentCount = CharCode.i, // added in BeepBox URL version 3
    patternCount = CharCode.j, // added in BeepBox URL version 3
    key = CharCode.k, // added in BeepBox URL version 2
    loopStart = CharCode.l, // added in BeepBox URL version 2
    reverb = CharCode.m, // added in BeepBox URL version 5, DEPRECATED
    channelCount = CharCode.n, // added in BeepBox URL version 6
    channelOctave = CharCode.o, // added in BeepBox URL version 3
    patterns = CharCode.p, // added in BeepBox URL version 2
    effects = CharCode.q, // added in BeepBox URL version 7
    rhythm = CharCode.r, // added in BeepBox URL version 2
    scale = CharCode.s, // added in BeepBox URL version 2
    tempo = CharCode.t, // added in BeepBox URL version 2
    preset = CharCode.u, // added in BeepBox URL version 7
    volume = CharCode.v, // added in BeepBox URL version 2
    wave = CharCode.w, // added in BeepBox URL version 2
    supersaw = CharCode.x, // added in BeepBox URL version 9 ([UB] was used for chip wave but is now DEPRECATED)
    loopControls = CharCode.y, // added in BeepBox URL version 7, DEPRECATED, [UB] repurposed for chip wave loop controls
    drumsetEnvelopes = CharCode.z, // added in BeepBox URL version 7 for filter envelopes, still used for drumset envelopes
    samplePitchLock = CharCode.J, // added in BreakBox: per-instrument flag to keep custom samples at their original speed (ignore pitch shift/detune)
    sampleMap = CharCode.K, // added in BreakBox 6B: per-pitch custom sample assignments (multiSample instrument)
    sampleMapSlices = CharCode.Z, // added in BreakBox Phase 2: per-pitch slice regions (transient auto-slicing)
    noteMetadata = CharCode.Y, // added in BreakBox Phase 3: per-note probability + rollCount (mirror-walk bitstream after patterns)
    algorithm = CharCode.A, // added in BeepBox URL version 6
    feedbackAmplitude = CharCode.B, // added in BeepBox URL version 6
    chord = CharCode.C, // added in BeepBox URL version 7, DEPRECATED
    detune = CharCode.D, // added in JummBox URL version 3(?) for detune, DEPRECATED
    envelopes = CharCode.E, // added in BeepBox URL version 6 for FM operator envelopes, repurposed in 9 for general envelopes.
    feedbackType = CharCode.F, // added in BeepBox URL version 6
    arpeggioSpeed = CharCode.G, // added in JummBox URL version 3 for arpeggioSpeed, DEPRECATED
    harmonics = CharCode.H, // added in BeepBox URL version 7
    stringSustain = CharCode.I, // added in BeepBox URL version 9
    //	                    = CharCode.J,
    //	                    = CharCode.K,
    pan = CharCode.L, // added between 8 and 9, DEPRECATED
    customChipWave = CharCode.M, // added in JummBox URL version 1(?) for customChipWave
    songTitle = CharCode.N, // added in JummBox URL version 1(?) for songTitle
    limiterSettings = CharCode.O, // added in JummBox URL version 3(?) for limiterSettings
    operatorAmplitudes = CharCode.P, // added in BeepBox URL version 6
    operatorFrequencies = CharCode.Q, // added in BeepBox URL version 6
    operatorWaves = CharCode.R, // added in JummBox URL version 4 for operatorWaves
    spectrum = CharCode.S, // added in BeepBox URL version 7
    startInstrument = CharCode.T, // added in BeepBox URL version 6
    channelNames = CharCode.U, // added in JummBox URL version 4(?) for channelNames
    feedbackEnvelope = CharCode.V, // added in BeepBox URL version 6, DEPRECATED
    pulseWidth = CharCode.W, // added in BeepBox URL version 7
    aliases = CharCode.X, // added in JummBox URL version 4 for aliases, DEPRECATED, [UB] repurposed for PWM decimal offset (DEPRECATED as well)
    //                      = CharCode.Y, 
    //	                    = CharCode.Z,
    //	                    = CharCode.NUM_0,
    //	                    = CharCode.NUM_1,
    //	                    = CharCode.NUM_2,
    //	                    = CharCode.NUM_3,
    //	                    = CharCode.NUM_4,
    //	                    = CharCode.NUM_5,
    //	                    = CharCode.NUM_6,
    //	                    = CharCode.NUM_7,
    //	                    = CharCode.NUM_8,
    //	                    = CharCode.NUM_9,
    //	                    = CharCode.DASH,
    //	                    = CharCode.UNDERSCORE,

}

export const base64IntToCharCode: ReadonlyArray<number> = [48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 45, 95];
export const base64CharCodeToInt: ReadonlyArray<number> = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 62, 62, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 0, 0, 0, 0, 0, 0, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 0, 0, 0, 0, 63, 0, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 0, 0, 0, 0, 0]; // 62 could be represented by either "-" or "." for historical reasons. New songs should use "-".

export class BitFieldReader {
    private _bits: number[] = [];
    private _readIndex: number = 0;

    constructor(source: string, startIndex: number, stopIndex: number) {
        for (let i: number = startIndex; i < stopIndex; i++) {
            const value: number = base64CharCodeToInt[source.charCodeAt(i)];
            this._bits.push((value >> 5) & 0x1);
            this._bits.push((value >> 4) & 0x1);
            this._bits.push((value >> 3) & 0x1);
            this._bits.push((value >> 2) & 0x1);
            this._bits.push((value >> 1) & 0x1);
            this._bits.push(value & 0x1);
        }
    }

    public read(bitCount: number): number {
        let result: number = 0;
        while (bitCount > 0) {
            result = result << 1;
            result += this._bits[this._readIndex++];
            bitCount--;
        }
        return result;
    }

    public readLongTail(minValue: number, minBits: number): number {
        let result: number = minValue;
        let numBits: number = minBits;
        while (this._bits[this._readIndex++]) {
            result += 1 << numBits;
            numBits++;
        }
        while (numBits > 0) {
            numBits--;
            if (this._bits[this._readIndex++]) {
                result += 1 << numBits;
            }
        }
        return result;
    }

    public readPartDuration(): number {
        return this.readLongTail(1, 3);
    }

    public readLegacyPartDuration(): number {
        return this.readLongTail(1, 2);
    }

    public readPinCount(): number {
        return this.readLongTail(1, 0);
    }

    public readPitchInterval(): number {
        if (this.read(1)) {
            return -this.readLongTail(1, 3);
        } else {
            return this.readLongTail(1, 3);
        }
    }
}

export class BitFieldWriter {
    private _index: number = 0;
    private _bits: number[] = [];

    public clear() {
        this._index = 0;
    }

    public write(bitCount: number, value: number): void {
        bitCount--;
        while (bitCount >= 0) {
            this._bits[this._index++] = (value >>> bitCount) & 1;
            bitCount--;
        }
    }

    public writeLongTail(minValue: number, minBits: number, value: number): void {
        if (value < minValue) throw new Error("value out of bounds");
        value -= minValue;
        let numBits: number = minBits;
        while (value >= (1 << numBits)) {
            this._bits[this._index++] = 1;
            value -= 1 << numBits;
            numBits++;
        }
        this._bits[this._index++] = 0;
        while (numBits > 0) {
            numBits--;
            this._bits[this._index++] = (value >>> numBits) & 1;
        }
    }

    public writePartDuration(value: number): void {
        this.writeLongTail(1, 3, value);
    }

    public writePinCount(value: number): void {
        this.writeLongTail(1, 0, value);
    }

    public writePitchInterval(value: number): void {
        if (value < 0) {
            this.write(1, 1); // sign
            this.writeLongTail(1, 3, -value);
        } else {
            this.write(1, 0); // sign
            this.writeLongTail(1, 3, value);
        }
    }

    public concat(other: BitFieldWriter): void {
        for (let i: number = 0; i < other._index; i++) {
            this._bits[this._index++] = other._bits[i];
        }
    }

    public encodeBase64(buffer: number[]): number[] {

        for (let i: number = 0; i < this._index; i += 6) {
            const value: number = (this._bits[i] << 5) | (this._bits[i + 1] << 4) | (this._bits[i + 2] << 3) | (this._bits[i + 3] << 2) | (this._bits[i + 4] << 1) | this._bits[i + 5];
            buffer.push(base64IntToCharCode[value]);
        }
        return buffer;
    }

    public lengthBase64(): number {
        return Math.ceil(this._index / 6);
    }
}
