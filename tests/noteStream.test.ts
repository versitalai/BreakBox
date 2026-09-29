// Safety net for note-independence work (docs/NOTE_INDEPENDENCE_PLAN.md, Phase 0).
// Pins down today's note-stream codec behaviour and the collision handler so
// later phases can change them deliberately.

import { Song, Note, Pattern, makeNotePin } from '../synth/model';
import { Config } from '../synth/SynthConfig';
import { ChangeNoteTruncate } from '../editor/core/changes';

(globalThis as any).OFFLINE = false;

// URL produced by builds before the note-independence format work, for the song in the "byte-identical" test.
const BASELINE_URL = "J5N08Untitledn511s0k08l00e03t2ma7g0fj07r1O_c000U00000000000000i0o32100T0v0pu0000f0000q0w42c00O0d040w20h0y00000000000002000000E0cT0v0pu0000f0000q0w42c00O0d040w20h0y00000000000002000000E0cT0v0pu0000f0000q0w42c00O0d040w20h0y00000000000002000000E0cT0v0pu0000f0000q0w42c00O0d040w20h0y00000000000002000000E0cT0v0pu0000f0000q0w42c00O0d040w20h0y00000000000002000000E0cT2v0pu0002f0000q0w42c00O0d040w1h0E0cTav0pu000af0000q000d040E0cb4h400000000h4g000000014h000000004h400000000h4g000000014h000000004h400000000p1sEOJJg8I2unw000002zeU3PY1_-00";

type Spec = [pitch: number, start: number, end: number];

function makeSong(channel: number, specs: Spec[]): Song {
    const song = new Song();
    song.channels[channel].bars[0] = 1;
    const pattern = song.channels[channel].patterns[0];
    pattern.notes.length = 0;
    for (const [pitch, start, end] of specs) {
        pattern.notes.push(new Note(pitch, start, end, 3));
    }
    return song;
}

function roundTrip(song: Song): Song {
    const song2 = new Song();
    song2.fromBase64String(song.toBase64String());
    return song2;
}

function summarize(pattern: Pattern): Spec[] {
    return pattern.notes.map((n): Spec => [n.pitches[0], n.start, n.end]);
}

function mockDoc(isMod: boolean): any {
    return {
        channel: 0,
        song: { getChannelIsMod: () => isMod },
        notifier: { changed: () => { } },
    };
}

describe("note stream codec", () => {
    it("round-trips sequential notes in a pitch channel", () => {
        const specs: Spec[] = [[12, 0, 6], [14, 6, 12], [16, 18, 24]];
        const out = roundTrip(makeSong(0, specs));
        expect(summarize(out.channels[0].patterns[0])).toEqual(specs);
    });

    it("round-trips overlapping notes in a mod channel", () => {
        const song = new Song();
        const mod = song.pitchChannelCount + song.noiseChannelCount;
        song.channels[mod].bars[0] = 1;
        const pattern = song.channels[mod].patterns[0];
        pattern.notes.length = 0;
        pattern.notes.push(new Note(0, 0, 12, 3), new Note(1, 4, 8, 3));
        const out = roundTrip(song);
        expect(summarize(out.channels[mod].patterns[0])).toEqual([[0, 0, 12], [1, 4, 8]]);
    });

    it("keeps the URL of songs without overlap byte-identical to earlier builds", () => {
        const song = makeSong(0, [[12, 0, 6], [14, 6, 12], [16, 18, 24]]);
        song.channels[song.pitchChannelCount].patterns[0].notes.push(new Note(4, 0, 8, 3));
        expect(song.toBase64String()).toBe(BASELINE_URL);
    });

    it("preserves overlapping notes of different pitch in a pitch channel", () => {
        const specs: Spec[] = [[12, 0, 12], [16, 4, 8]];
        const out = roundTrip(makeSong(0, specs));
        expect(summarize(out.channels[0].patterns[0])).toEqual(specs);
        expect(out.channels[0].overlapStream).toBe(true);
    });

    it("preserves same-pitch and identical duplicate notes", () => {
        const specs: Spec[] = [[12, 0, 12], [12, 4, 20], [12, 4, 20], [7, 4, 6], [19, 30, 32]];
        const out = roundTrip(makeSong(0, specs));
        expect(summarize(out.channels[0].patterns[0])).toEqual(specs);
    });

    it("preserves overlapping notes ending at the bar edge", () => {
        const end = 8 * Config.partsPerBeat;
        const specs: Spec[] = [[5, 0, end], [9, 2, end], [2, end - 3, end]];
        const out = roundTrip(makeSong(0, specs));
        expect(summarize(out.channels[0].patterns[0])).toEqual(specs);
    });

    it("preserves pins, chords and continuesLastPattern on overlapping notes", () => {
        const song = makeSong(0, [[12, 0, 12], [16, 4, 10]]);
        const [first, second] = song.channels[0].patterns[0].notes;
        first.continuesLastPattern = true;
        first.pitches.push(19);
        second.pins.splice(1, 0, makeNotePin(3, 2, 2));
        const out = roundTrip(song);
        const [a, b] = out.channels[0].patterns[0].notes;
        expect(a.pitches).toEqual([12, 19]);
        expect(a.continuesLastPattern).toBe(true);
        expect(b.pins.map(p => [p.interval, p.time, p.size])).toEqual([[0, 0, 3], [3, 2, 2], [0, 6, 3]]);
    });

    it("preserves overlapping notes in a noise channel", () => {
        const song = new Song();
        const noise = song.pitchChannelCount;
        song.channels[noise].bars[0] = 1;
        const pattern = song.channels[noise].patterns[0];
        pattern.notes.length = 0;
        pattern.notes.push(new Note(1, 0, 12, 3), new Note(3, 4, 8, 3));
        const out = roundTrip(song);
        expect(summarize(out.channels[noise].patterns[0])).toEqual([[1, 0, 12], [3, 4, 8]]);
    });

    it("keeps non-overlapping channels of the same song unchanged", () => {
        const song = makeSong(0, [[12, 0, 12], [16, 4, 8]]);
        const other = song.channels[1].patterns[0];
        song.channels[1].bars[0] = 1;
        other.notes.length = 0;
        other.notes.push(new Note(7, 0, 6, 3), new Note(9, 6, 9, 3));
        const out = roundTrip(song);
        expect(summarize(out.channels[1].patterns[0])).toEqual([[7, 0, 6], [9, 6, 9]]);
        expect(out.channels[1].overlapStream).toBe(false);
    });

    it("round-trips the independence and chord-building flags", () => {
        const song = makeSong(0, [[12, 0, 6]]);
        song.channels[0].independentNotes = true;
        song.channels[1].chordBuilding = false;
        const out = roundTrip(song);
        expect(out.channels[0].independentNotes).toBe(true);
        expect(out.channels[0].chordBuilding).toBe(true);
        expect(out.channels[1].independentNotes).toBe(false);
        expect(out.channels[1].chordBuilding).toBe(false);
        expect(out.channels[2].independentNotes).toBe(false);
        expect(out.channels[2].chordBuilding).toBe(true);
    });

    it("clears channel flags when a plain song is loaded into a used Song", () => {
        const flagged = makeSong(0, [[12, 0, 12], [16, 4, 8]]);
        flagged.channels[0].independentNotes = true;
        const plain = makeSong(0, [[12, 0, 6]]);
        const target = new Song();
        target.fromBase64String(flagged.toBase64String());
        target.fromBase64String(plain.toBase64String());
        expect(target.channels[0].independentNotes).toBe(false);
        expect(target.channels[0].overlapStream).toBe(false);
        expect(summarize(target.channels[0].patterns[0])).toEqual([[12, 0, 6]]);
    });

    it("round-trips overlapping notes and flags through JSON", () => {
        const song = makeSong(0, [[12, 0, 12], [16, 4, 8]]);
        song.channels[0].independentNotes = true;
        song.channels[0].chordBuilding = false;
        const out = new Song();
        out.fromJsonObject(JSON.parse(JSON.stringify(song.toJsonObject())));
        expect(summarize(out.channels[0].patterns[0])).toEqual([[12, 0, 12], [16, 4, 8]]);
        expect(out.channels[0].independentNotes).toBe(true);
        expect(out.channels[0].chordBuilding).toBe(false);
    });
});

describe("ChangeNoteTruncate", () => {
    it("trims every overlapping note in pitch channels when a note is skipped", () => {
        const song = makeSong(0, [[12, 0, 8], [16, 4, 12]]);
        const pattern = song.channels[0].patterns[0];
        const moved = pattern.notes[1];
        pattern.assignNoteId(pattern.notes[0]);
        pattern.assignNoteId(moved);

        // Resize call sites pass the note being edited as skipNote only.
        new ChangeNoteTruncate(mockDoc(false), pattern, 4, 12, moved);

        expect(summarize(pattern)).toEqual([[12, 0, 4], [16, 4, 12]]);
    });

    it("is a no-op when targetNoteId names the skipped note (why callers must not pass both)", () => {
        const song = makeSong(0, [[12, 0, 8], [16, 4, 12]]);
        const pattern = song.channels[0].patterns[0];
        const moved = pattern.notes[1];
        pattern.assignNoteId(pattern.notes[0]);
        pattern.assignNoteId(moved);

        new ChangeNoteTruncate(mockDoc(false), pattern, 4, 12, moved, false, moved.noteId);

        expect(summarize(pattern)).toEqual([[12, 0, 8], [16, 4, 12]]);
    });

    it("only affects same-pitch notes in mod channels", () => {
        const song = makeSong(0, [[3, 0, 8], [5, 0, 8]]);
        const pattern = song.channels[0].patterns[0];

        new ChangeNoteTruncate(mockDoc(true), pattern, 4, 8, new Note(3, 0, 0, 0));

        expect(summarize(pattern)).toEqual([[3, 0, 4], [5, 0, 8]]);
    });
});
