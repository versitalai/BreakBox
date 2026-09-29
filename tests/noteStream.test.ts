// Safety net for note-independence work (docs/NOTE_INDEPENDENCE_PLAN.md, Phase 0).
// Pins down today's note-stream codec behaviour and the collision handler so
// later phases can change them deliberately.

import { Song, Note, Pattern } from '../synth/model';
import { ChangeNoteTruncate } from '../editor/core/changes';

(globalThis as any).OFFLINE = false;

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

    // Documents the corruption described in the plan (Part 1.4). When Phase 1
    // lands, flip this to a normal `it` for channels that opt in.
    it("does NOT preserve overlapping notes in a pitch channel today", () => {
        const specs: Spec[] = [[12, 0, 12], [16, 4, 8]];
        const out = roundTrip(makeSong(0, specs));
        expect(summarize(out.channels[0].patterns[0])).not.toEqual(specs);
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
